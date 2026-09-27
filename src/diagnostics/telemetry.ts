/**
 * Reports for when a store still works but loses the benefit a path exists for, such as a native shred falling back to
 * JS. Each is sent once per session, to the dev console and the error sink. `severity: 'info'` is for expected events
 * that shouldn't read as faults.
 */

import { errorSink } from '../runtime';
import { shouldLog } from './log_level';
import { createOnceGuard } from './once_guard';

const reportedScopes = createOnceGuard();


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
  /** `error` by default; `info` for an expected event, sent as a message rather than an exception. */
  severity?: 'error' | 'info';
  /** The chance the report reaches the error sink, from 0 to 1; 1 by default. */
  sampleRate?: number;
}): void {
  const { scope, context, error, extra, severity = 'error', sampleRate = 1 } = args;

  if (reportedScopes.seen(scope)) return;

  if (__DEV__ && shouldLog(severity === 'info' ? 'info' : 'error')) {
    // An `info` report is something that was always going to happen, not a path that lost the win it exists for, and
    // reading it as the latter sends people looking for a fault.
    // eslint-disable-next-line no-console
    console.warn(`[cellar ${severity === 'info' ? 'notice' : 'degraded'}] ${scope}: ${context}`, error ?? '', extra ?? '');
  }

  if (!(sampleRate >= 1) && Math.random() >= sampleRate) return;

  const sink = errorSink();
  const captureContext = {
    tags: { cellar_degradation: scope },
    fingerprint: ['cellar-degradation', scope],
    extra: { context, ...extra },
  };

  if (severity === 'info') sink.captureMessage(`${scope}: ${context}`, { level: 'info', ...captureContext });
  else sink.captureException(error instanceof Error ? error : new Error(`${scope}: ${context}`), captureContext);
}
