"use strict";

/**
 * How much Cellar logs to the console: nothing, errors, warnings too, notices too, or advice too. It doesn't affect error
 * reports, which reach the error sink at its own {@linkcode ErrorSink.minSeverity | minSeverity}.
 *
 * The default is `error`, because most warnings and notices can't be acted on where they appear, and logging them on
 * every launch teaches people to ignore the console.
 */

/** Ascending, so a level shows everything at or below its own rank. */
const RANK = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  verbose: 4
};
let current = 'error';

/** Sets how much Cellar logs to the console. */
export function setLogLevel(level) {
  current = level;
}

/** How much Cellar logs to the console. */
export function getLogLevel() {
  return current;
}

/** Whether a message of this level is logged at the current level. */
export function shouldLog(level) {
  return RANK[current] >= RANK[level];
}
//# sourceMappingURL=log_level.js.map