/**
 * The Node writer: a worker thread that owns a store's database for writing, so parsing a fetched body and writing its
 * rows happen off the thread that renders. It takes requests over one port, in order, and answers each on that port,
 * or, for a call the main thread is blocked on, on the sync port with a signal it waits on.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type MessagePort } from 'node:worker_threads';
import type { BatchCommand, ShredCommand } from '../table/connection';
/** What the main thread hands the writer when it starts. */
export interface WriterData {
    path: string;
    requests: MessagePort;
    replies: MessagePort;
    signal: SharedArrayBuffer;
}
export type Param = string | number | null | undefined;
export type WriterRequest = {
    id: number;
    sync: boolean;
    kind: 'execute';
    sql: string;
    params?: readonly Param[];
} | {
    id: number;
    sync: boolean;
    kind: 'batch';
    commands: ReadonlyArray<BatchCommand | ShredCommand>;
} | {
    id: number;
    sync: true;
    kind: 'ready';
};
export type WriterReply = {
    id: number;
    rows?: unknown[];
    error?: {
        message: string;
        code?: string;
    };
};
/**
 * `node:sqlite`, loaded at run time rather than imported: a bundler that doesn't know the module yet would turn a static
 * import into a reference it can't resolve, and fail the build of the server that bundles this.
 */
export declare function nodeSqlite(): typeof import('node:sqlite');
/** A connection's statements by SQL, most recently used last, so the oldest is the first evicted. */
export declare function statementCache(db: DatabaseSync): (sql: string) => StatementSync;
/** `undefined` binds as NULL, the way every other connection takes it. */
export declare function bindable(params: readonly Param[] | undefined): Array<string | number | null>;
//# sourceMappingURL=writer.d.ts.map