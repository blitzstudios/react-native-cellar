/**
 * Reports for when a store still works but loses the benefit a path exists for, such as a native shred falling back to
 * JS. Each is sent once per session, to the dev console and the error sink. `severity: 'info'` is for expected events
 * that shouldn't read as faults.
 */
import { type Severity } from '../runtime';
/** Reports that a store lost a benefit it should have had, at most once per `scope` per session. */
export declare function reportStoreDegradation(args: {
    /** Where it happened, as a stable, searchable id, such as `row_table.native_shred.<store>`. */
    scope: string;
    /** What happened, in a sentence. */
    context: string;
    /** The error behind it, if any. */
    error?: unknown;
    /** Details attached to the report. */
    extra?: Record<string, unknown>;
    /**
     * `error` by default, or `info` when `error` is a storage failure (a full disk, or a file the device won't open);
     * `info` for an expected event, sent as a message; `verbose` for advice to a developer.
     */
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
}): void;
//# sourceMappingURL=telemetry.d.ts.map