/**
 * What Cellar recorded about itself, for a developer surface to dump. Nothing a store, a screen or a service
 * renders from reads this, which is why it sits behind its own entry point rather than the main one.
 */

export type { IngestRollup, IngestTiming } from './ingest_timing';
export { getIngestTimings, rollupIngestTimings } from './ingest_timing';
export { getLogLevel, setLogLevel, type LogLevel } from './log_level';
