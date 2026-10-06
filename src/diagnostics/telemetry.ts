/**
 * Reports for when a store still works but loses the benefit a path exists for, such as a native shred falling back to
 * JS. Each is sent once per session, to the dev console and the error sink. `severity: 'info'` is for expected events
 * that shouldn't read as faults.
 */

import { errorSink, type Severity } from '../runtime';
import { shouldLog } from './log_level';
import { createOnceGuard } from './once_guard';
import { recordInspectorEvent } from '../inspector/events';
import type { InspectorDegradationEvent } from '../inspector/events';
import { renderPhaseOwnerStack } from '../reactivity/render_phase';

const SEVERITY_RANK: Record<Severity, number> = { verbose: 0, info: 1, error: 2 };
const reportedScopes = createOnceGuard();
const messageOf = (error: unknown): string => String((error as { message?: unknown })?.message ?? error);
/** How many times each scope has been reported this session, first report included. Dev only. */
const scopeCounts = new Map<string, number>();

/** The report's details as JSON carries them: numbers, strings and booleans as they are, anything else as text. */
function plainExtra(extra: Record<string, unknown>): NonNullable<InspectorDegradationEvent['extra']> {
  const out: NonNullable<InspectorDegradationEvent['extra']> = {};
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? value : String(JSON.stringify(value) ?? value).slice(0, 500);
  }
  return out;
}

/**
 * Where the report came from: the caller's own, else the component rendering now, else the JS stack without this
 * file's frames.
 */
function callsiteOf(given: string | undefined, kind: 'component' | 'stack' = 'component'): Pick<InspectorDegradationEvent, 'callsite' | 'callsiteKind'> {
  if (given) return { callsite: given, callsiteKind: kind };
  const owner = renderPhaseOwnerStack();
  if (owner) return { callsite: owner, callsiteKind: 'component' };
  const stack = new Error().stack?.split('\n').slice(3).join('\n');
  return stack ? { callsite: stack, callsiteKind: 'stack' } : {};
}

/** Reports that a store lost a benefit it should have had, at most once per `scope` per session. */
export function reportStoreDegradation(args: {
  /** Where it happened, as a stable, searchable id, such as `row_table.native_shred.<store>`. */
  scope: string;
  /** What happened, in a sentence. */
  context: string;
  /** The error behind it, if any. */
  error?: unknown;
  /** Details attached to the report. */
  extra?: Record<string, unknown>;
  /** `error` by default; `info` for an expected event, sent as a message; `verbose` for advice to a developer. */
  severity?: Severity;
  /** The chance the report reaches the error sink, from 0 to 1; 1 by default. */
  sampleRate?: number;
  /**
   * The component chain (a React owner stack) of the code that caused this, for a report filed away from its cause,
   * such as after a fetch. Left out, the report is attributed to the component rendering when it is filed, or to the JS
   * stack. Dev only.
   */
  callsite?: string;
  /** Whether {@linkcode callsite} is a React owner stack (`component`, the default) or a JS stack (`stack`). */
  callsiteKind?: 'component' | 'stack';
}): void {
  const { scope, context, error, extra, severity = 'error', sampleRate = 1 } = args;

  const first = !reportedScopes.seen(scope);
  if (__DEV__) {
    const count = (scopeCounts.get(scope) ?? 0) + 1;
    scopeCounts.set(scope, count);
    recordInspectorEvent({
      kind: 'degradation',
      scope,
      context,
      severity,
      first,
      count,
      ...(error === undefined ? {} : { error: messageOf(error) }),
      ...(extra ? { extra: plainExtra(extra) } : {}),
      ...callsiteOf(args.callsite, args.callsiteKind),
    });
  }
  if (!first) return;

  if (__DEV__ && shouldLog(severity)) {
    // An `info` report is something that was always going to happen, not a path that lost the win it exists for, and
    // reading it as the latter sends people looking for a fault.
    // eslint-disable-next-line no-console
    console.warn(`[cellar ${severity === 'error' ? 'degraded' : 'notice'}] ${scope}: ${context}`, error ?? '', extra ?? '');
  }

  const sink = errorSink();
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[sink.minSeverity ?? 'verbose']) return;
  const rate = severity === 'error' ? sampleRate : sampleRate * (sink.infoSampleRate ?? 1);
  if (!(rate >= 1) && Math.random() >= rate) return;

  const captureContext = {
    tags: { cellar_degradation: scope },
    fingerprint: ['cellar-degradation', scope],
    extra: { context, ...extra },
  };

  if (severity !== 'error') sink.captureMessage(`${scope}: ${context}`, { level: severity === 'info' ? 'info' : 'debug', ...captureContext });
  else sink.captureException(error instanceof Error ? error : new Error(`${scope}: ${context}`), captureContext);
}
