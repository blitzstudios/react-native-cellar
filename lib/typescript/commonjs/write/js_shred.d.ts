/**
 * A native shred run in JS: the statements a {@linkcode ShredCommand} writes, with the body parsed and each element's
 * row built by the spec's reference interpreter. What a connection without the C++ shred runs: sql.js in tests, and the
 * Node writer, off the main thread.
 */
import type { BatchCommand, ShredCommand } from '../table/connection';
/** The statements one shred command runs: its delete, then one insert per element of the body. */
export declare function shredCommandStatements({ shred: spec, rawJson, binds }: ShredCommand): BatchCommand[];
//# sourceMappingURL=js_shred.d.ts.map