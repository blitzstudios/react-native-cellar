/**
 * What the stores did recently, for a development tool to show: writes, moves between databases, fetches and
 * degradation reports, kept in one bounded log and handed to listeners as they happen. Recorded only in a development
 * build; a release build records nothing and keeps no log.
 */
/**
 * Where a store's rows are: its own database (a file on a device, sql.js on web), the in-memory database it falls back
 * to, or nowhere, with every read empty.
 */
export type InspectedBindingState = 'database' | 'memory' | 'unbound';
/** Which database a store runs on, and since when. */
export interface InspectedBinding {
    /** Whether the store runs on its own database, on the in-memory fallback, or on nothing. */
    state: InspectedBindingState;
    /** The database's name as the bind gave it, such as `player_stats.db`; absent when the bind didn't name it. */
    database?: string;
    /** When the store moved onto it, as a `Date.now()` timestamp. */
    since: number;
    /** How many times this session the store reopened its database after a failure. */
    reopens: number;
}
interface EventBase {
    /** A number that goes up by one with each event, so a listener can tell which it has already seen. */
    id: number;
    /** When it happened, as a `Date.now()` timestamp. */
    at: number;
}
/** A write that changed a partition's rows: a fetch's, a push's, or one the store made itself. */
export interface InspectorWriteEvent extends EventBase {
    kind: 'write';
    /** The store's name, such as `player_stats_store`. */
    store: string;
    /** The partition's key. */
    partition: string;
    /** The partition's version after the write. */
    version: number;
    /**
     * The entity ids the write changed, at most {@linkcode MAX_EVENT_ENTITIES} of them, or `'all'` when the write counted
     * every entity as changed.
     */
    entities: string[] | 'all';
    /** How many entities the write changed, or `null` when it counted every entity as changed. */
    entityCount: number | null;
}
/** A store moving onto a database: bound at startup, reopened after a failure, moved to memory, or left unbound. */
export interface InspectorBindingEvent extends EventBase {
    kind: 'binding';
    /** The store's name. */
    store: string;
    /** Where the store runs from now on. */
    binding: InspectedBinding;
}
/** A partition fetch finishing, 304s included: how long the request and the write took. */
export interface InspectorFetchEvent extends EventBase {
    kind: 'fetch';
    /** The store's name. */
    store: string;
    /** The partition's key parts, as a label. */
    partition: string;
    /** How long the request took, in ms. */
    fetchMs: number;
    /** How long writing the rows took, in ms. */
    ingestMs: number;
    /** The response body's length in characters; `null` for a 304. */
    chars: number | null;
    /** How many rows were written: `-1` for a 304, `-2` for a body identical to the last one. */
    rows: number;
}
/** A store reporting that it lost a benefit it should have had, or an expected event worth knowing about. */
export interface InspectorDegradationEvent extends EventBase {
    kind: 'degradation';
    /** Where it happened, as a stable id, such as `player_stats_store.in_memory`. */
    scope: string;
    /** What happened, in a sentence. */
    context: string;
    /** `error` for a fault, `info` for an expected event, `verbose` for advice. */
    severity: 'error' | 'info' | 'verbose';
    /** The error's message, if the report carried one. */
    error?: string;
    /** Whether this is the scope's first report this session; later ones reach neither the console nor the error sink. */
    first: boolean;
    /** How many times the scope has been reported this session, this one included. */
    count: number;
    /** The report's numbers and names, such as `{ rows: 9422, chars: 5759138 }`; anything else arrives as text. */
    extra?: Record<string, string | number | boolean | null>;
    /**
     * Where it came from: a React owner stack (`\n    at Component (file:line:col)` lines) when `callsiteKind` is
     * `component`, a JS stack when it is `stack`. The locations are the bundle's, for a tool to symbolicate.
     */
    callsite?: string;
    callsiteKind?: 'component' | 'stack';
}
/** Anything the inspector's log records. */
export type InspectorEvent = InspectorWriteEvent | InspectorBindingEvent | InspectorFetchEvent | InspectorDegradationEvent;
/** An event as it is recorded, before the log numbers and timestamps it. */
export type InspectorEventInput = Omit<InspectorWriteEvent, 'id' | 'at'> | Omit<InspectorBindingEvent, 'id' | 'at'> | (Omit<InspectorFetchEvent, 'id' | 'at'> & {
    at?: number;
}) | Omit<InspectorDegradationEvent, 'id' | 'at'>;
/** How many events the log keeps; past this, the oldest go. */
export declare const EVENT_CAPACITY = 1000;
/** How many entity ids a write event lists. */
export declare const MAX_EVENT_ENTITIES = 50;
/** Records an event and hands it to every listener. Does nothing in a release build. */
export declare function recordInspectorEvent(input: InspectorEventInput): void;
/** The recorded events, oldest first; only those after `afterId` when it is given. */
export declare function recentInspectorEvents(afterId?: number): InspectorEvent[];
/** Calls `listener` with each event as it is recorded, and returns a function that stops it. */
export declare function onInspectorEvent(listener: (event: InspectorEvent) => void): () => void;
/** Empties the log, so a test sees only its own events. */
export declare function clearInspectorEvents(): void;
export {};
//# sourceMappingURL=events.d.ts.map