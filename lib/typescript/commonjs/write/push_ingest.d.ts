/**
 * The push ingest: how a store writes items that arrive by socket push rather than by fetch. Queued items are buffered
 * per partition (a partition is the set of rows one fetch returns and replaces), with only the latest item kept per id,
 * and written shortly after, outside the render that received them, with {@linkcode RowTable.upsert | upsert} in
 * chunks. After a write, the partitions whose rows changed are bumped with their change sets, so only readers of the
 * changed entities re-render. A chunk that fails to write is queued again and retried after a delay, unless a newer
 * item with the same id arrived meanwhile.
 */
import { RowShape, RowTable } from '../table/types';
import { ChangeSet } from '../table/change_set';
import type { PartitionFetchSpec, PartitionKeySpec } from '../define_partitions';
/** How {@linkcode createPushIngest} turns a store's pushed items into rows and tells readers about them. */
export interface PushIngestConfig<Item, Row extends RowShape, Key> {
    /** The store's name, used in error reports. */
    name: string;
    /** The store's row table, which the rows are upserted into. It needs a primary key. */
    table: RowTable<Row>;
    /**
     * The column values that pick out a partition's rows in the table, such as `{ league: 'nfl' }`: the store's
     * {@linkcode PartitionKeySpec.where | key.where}.
     */
    where: (key: Key) => Partial<Row>;
    /**
     * The id a queued item is deduplicated by within its partition: when several items with the same id are queued before
     * a write, only the latest is written. Two items that should both be written need different ids, such as a stat
     * line's own id rather than its player's.
     */
    idOf: (item: Item) => string;
    /**
     * Turns a batch of a partition's queued items into table rows. Every row must belong to that partition; an item can
     * produce no rows, and is then skipped.
     */
    toRows: (key: Key, items: readonly Item[]) => Row[];
    /**
     * Tells the partition's readers about a write, with its change set: the entity id (such as a `player_id`) of each row
     * that was new or different. Only readers of the whole partition and of those entities re-render. Not called for a
     * write that changed nothing.
     */
    bump: (key: Key, changes: ChangeSet) => void;
    /**
     * Called for each partition whose rows a write changed, before {@linkcode PushIngestConfig.bump | bump}, such as to
     * delete the partition's ETag so the next fetch downloads a full body instead of getting a 304 that would miss the
     * pushed rows.
     */
    onWrite: (key: Key) => void;
    /** How many rows to write per transaction; 250 by default. The JS thread is given back between transactions. */
    chunk?: number;
    /** How long to wait before retrying items whose write failed, in ms; 1000 by default. */
    retryDelayMs?: number;
}
/** A store's buffer for pushed items, as {@linkcode createPushIngest} creates it. */
export interface PushIngest<Item, Key> {
    /**
     * Queues one pushed item for the partition the key names. Queued items are written together, soon after and outside
     * the current render; an item replaces any queued item with the same id.
     */
    queue: (key: Key, item: Item) => void;
    /**
     * Holds the partition's queued items (they stay queued and unwritten) until the returned function is called, which
     * then writes them. Pass it as the partition's {@linkcode PartitionFetchSpec.holdWrites | fetch.holdWrites}: a fetch
     * replaces the whole partition, so an item written while the request was in flight would be overwritten by the older
     * response. Holds on one partition can overlap, and the items are written once every hold is released; calling a
     * release twice does nothing.
     */
    hold: (key: Key) => () => void;
}
/**
 * Creates the push ingest for a store whose rows (also) arrive by socket push. Items are queued per partition, with
 * only the latest kept per id, and written together shortly after with {@linkcode RowTable.upsert | upsert}, outside
 * the render that received them: a burst of pushes costs one write per row rather than one per push. Readers of the
 * changed entities re-render once the write finishes.
 */
export declare function createPushIngest<Item, Row extends RowShape, Key>(config: PushIngestConfig<Item, Row, Key>): PushIngest<Item, Key>;
export type { PartitionFetchSpec, PartitionKeySpec, RowTable };
//# sourceMappingURL=push_ingest.d.ts.map