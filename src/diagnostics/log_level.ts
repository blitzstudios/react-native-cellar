/**
 * How much Cellar logs to the console: nothing, errors, warnings too, notices too, or advice too. It doesn't affect error
 * reports, which reach the error sink at its own {@linkcode ErrorSink.minSeverity | minSeverity}.
 *
 * The default is `error`, because most warnings and notices can't be acted on where they appear, and logging them on
 * every launch teaches people to ignore the console.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose';

/** Ascending, so a level shows everything at or below its own rank. */
const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, verbose: 4 };

let current: LogLevel = 'error';

/** Sets how much Cellar logs to the console. */
export function setLogLevel(level: LogLevel): void {
  current = level;
}

/** How much Cellar logs to the console. */
export function getLogLevel(): LogLevel {
  return current;
}

/** Whether a message of this level is logged at the current level. */
export function shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
  return RANK[current] >= RANK[level];
}
