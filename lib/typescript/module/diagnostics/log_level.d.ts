/**
 * How much Cellar logs to the console: nothing, errors, warnings too, notices too, or advice too. It doesn't affect error
 * reports, which reach the error sink at its own {@linkcode ErrorSink.minSeverity | minSeverity}.
 *
 * The default is `error`, because most warnings and notices can't be acted on where they appear, and logging them on
 * every launch teaches people to ignore the console.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose';
/** Sets how much Cellar logs to the console. */
export declare function setLogLevel(level: LogLevel): void;
/** How much Cellar logs to the console. */
export declare function getLogLevel(): LogLevel;
/** Whether a message of this level is logged at the current level. */
export declare function shouldLog(level: Exclude<LogLevel, 'silent'>): boolean;
//# sourceMappingURL=log_level.d.ts.map