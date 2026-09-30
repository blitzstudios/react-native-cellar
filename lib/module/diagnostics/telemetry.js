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
const reportedScopes = createOnceGuard();
const messageOf = error => String(error?.message ?? error);

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
    recordInspectorEvent({
      kind: 'degradation',
      scope,
      context,
      severity,
      first,
      ...(error === undefined ? {} : {
        error: messageOf(error)
      })
    });
  }
  if (!first) return;
  if (__DEV__ && shouldLog(severity === 'info' ? 'info' : 'error')) {
    // An `info` report is something that was always going to happen, not a path that lost the win it exists for, and
    // reading it as the latter sends people looking for a fault.
    // eslint-disable-next-line no-console
    console.warn(`[cellar ${severity === 'info' ? 'notice' : 'degraded'}] ${scope}: ${context}`, error ?? '', extra ?? '');
  }
  if (!(sampleRate >= 1) && Math.random() >= sampleRate) return;
  const sink = errorSink();
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
  if (severity === 'info') sink.captureMessage(`${scope}: ${context}`, {
    level: 'info',
    ...captureContext
  });else sink.captureException(error instanceof Error ? error : new Error(`${scope}: ${context}`), captureContext);
}
//# sourceMappingURL=telemetry.js.map