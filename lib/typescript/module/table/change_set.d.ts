/**
 * Change sets: what a write changed, as entity ids rather than rows. An entity is the thing a row belongs to, such as
 * one player, named by the table's `entityId` column; a write's change set is the entity id of each row it added,
 * changed or removed. Bumping a partition with its change set re-runs only the reads that depend on those entities (or
 * on the whole partition), and an empty change set re-runs nothing.
 */
/**
 * A change set meaning every entity in the partition changed, for a write that can't say which entities it changed,
 * such as a store bumping by hand. Bumping with it re-runs every read of the partition.
 */
export declare const ALL_ENTITIES: "all";
/**
 * What a write changed: the entity id (such as a `player_id`) of each row it added, changed or removed, or
 * {@linkcode ALL_ENTITIES} when every entity counts as changed. An empty set means the write changed nothing.
 */
export type ChangeSet = typeof ALL_ENTITIES | ReadonlySet<string>;
/** What a row table write returns: its change set, and how many rows it was given. */
export interface WriteResult {
    /**
     * The write's change set: the entity id (such as a `player_id`) of each row it added, changed or removed. Empty if
     * the rows matched what the table held.
     */
    changes: ChangeSet;
    /** How many rows the write was given, whether or not they changed anything. */
    rows: number;
    /** Where a shredded body's write spent its time. Only `shred` reports it. */
    steps?: WriteSteps;
}
/**
 * Where one shredded body's write spent its time, in whole ms. SQLite times the work its batch does, so a busy JS
 * thread shows up only as `resumeMs`, and a slow native step is slow native work.
 */
export interface WriteSteps {
    /**
     * How the body was written: shredded natively or parsed in JS, through the stage or, for a partition that held no
     * rows, `direct` into the table.
     */
    path: 'native' | 'native-direct' | 'js' | 'js-direct';
    /** Waiting behind the store's earlier writes. */
    queuedMs: number;
    /**
     * Shredding the body: natively, as SQLite timed it, or parsing it into rows in JS, a failed native attempt
     * included.
     */
    shredMs: number;
    /** Comparing the rows with the table's and applying the difference, as SQLite timed it; on `js`, staging them too. */
    applyMs: number;
    /** Handing the batch to native code: building it on the JS thread, and waiting for a native thread to start it. */
    dispatchMs: number;
    /** From the batch finishing until the JS thread picked up its result, which a busy JS thread makes long. */
    resumeMs: number;
    /** Reading back which entities changed, on the JS thread. */
    readBackMs: number;
}
/** The change set of a write that changed nothing: an empty set, frozen so it can be shared. */
export declare const NO_CHANGES: ReadonlySet<string>;
/** Whether a change set is empty (the write changed nothing), in which case bumping with it does nothing. */
export declare function isUnchanged(changes: ChangeSet): boolean;
/**
 * Combines the change sets of two writes into one (every entity either changed), such as the chunks of one push. If
 * either is {@linkcode ALL_ENTITIES}, so is the result.
 */
export declare function unionChanges(left: ChangeSet, right: ChangeSet): ChangeSet;
/** Whether a write touched any of `entities`. Walks the smaller side, since a change set is usually a handful. */
export declare function touchesAny(changes: ChangeSet, entityIds: ReadonlySet<string>): boolean;
//# sourceMappingURL=change_set.d.ts.map