"use strict";

/**
 * Reports for when a store still works but loses the benefit a path exists for, such as a native shred falling back to
 * JS. Each is sent once per session, to the dev console and the error sink. `severity: 'info'` is for expected events
 * that shouldn't read as faults.
 */

import { errorSink } from "../runtime.js";
import { shouldLog } from "./log_level.js";
import { createOnceGuard } from "./once_guard.js";
import { recordInspectorEvent } from "../inspector/events.js";
import { renderPhaseOwnerStack } from "../reactivity/render_phase.js";
const SEVERITY_RANK = {
  verbose: 0,
  info: 1,
  error: 2
};
const reportedScopes = createOnceGuard();
const messageOf = error => String(error?.message ?? error);
/** How many times each scope has been reported this session, first report included. Dev only. */
const scopeCounts = new Map();

/** The report's details as JSON carries them: numbers, strings and booleans as they are, anything else as text. */
function plainExtra(extra) {
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? value : String(JSON.stringify(value) ?? value).slice(0, 500);
  }
  return out;
}

/**
 * Where the report came from: the caller's own, else the component rendering now, else the JS stack without this
 * file's frames.
 */
function callsiteOf(given, kind = 'component') {
  if (given) return {
    callsite: given,
    callsiteKind: kind
  };
  const owner = renderPhaseOwnerStack();
  if (owner) return {
    callsite: owner,
    callsiteKind: 'component'
  };
  const stack = new Error().stack?.split('\n').slice(3).join('\n');
  return stack ? {
    callsite: stack,
    callsiteKind: 'stack'
  } : {};
}

/** Reports that a store lost a benefit it should have had, at most once per `scope` per session. */
export function reportStoreDegradation(args) {
  const {
    scope,
    context,
    error,
    extra,
    severity = 'error',
    sampleRate = 1
  } = args;
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
      ...(error === undefined ? {} : {
        error: messageOf(error)
      }),
      ...(extra ? {
        extra: plainExtra(extra)
      } : {}),
      ...callsiteOf(args.callsite, args.callsiteKind)
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
    tags: {
      cellar_degradation: scope
    },
    fingerprint: ['cellar-degradation', scope],
    extra: {
      context,
      ...extra
    }
  };
  if (severity !== 'error') sink.captureMessage(`${scope}: ${context}`, {
    level: severity === 'info' ? 'info' : 'debug',
    ...captureContext
  });else sink.captureException(error instanceof Error ? error : new Error(`${scope}: ${context}`), captureContext);
}
//# sourceMappingURL=telemetry.js.map