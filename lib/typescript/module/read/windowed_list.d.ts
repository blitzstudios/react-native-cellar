/**
 * A windowed list: a long list read, plus a detail read for each row that is done in blocks of rows rather than one row
 * at a time. Every row in a block calls the detail read with the block's ids, so the block's rows share one cached read
 * and one fetch, however many of them render.
 */
import type { ReadOptions } from './facade';
import { DataResult } from '../store_result';
/** The reads and functions a {@linkcode createWindowedList} is built from. */
export interface WindowedListSpec<Params, Row extends object, Detail> {
    /** The hook that reads the whole list, such as a ranked list of players. */
    useList: (args: {
        /** The list read's args. */
        params: Params;
    } & ReadOptions) => DataResult<Row[]>;
    /** A row's id, which the detail read looks the row up by. */
    idOf: (row: Row) => string;
    /**
     * The detail a list row already carries, if any. A row that returns one uses it, and isn't included in its block's
     * detail read.
     */
    prehydrated: (row: Row) => Detail | undefined;
    /**
     * The detail read for a block of rows: a hook that takes the list's params and the block's row ids, and returns each
     * id's detail keyed by id (`undefined` while loading). Every row calls it on every render with its block's ids, so
     * the rows of one block share one cached read. When `enabled` is false it must read and fetch nothing.
     */
    useDetailByIds: (params: Params, ids: readonly string[], enabled: boolean) => Record<string, Detail> | undefined;
    /** How many consecutive rows form a block and share one detail read; 50 by default. */
    blockSize?: number;
}
/**
 * A block: consecutive rows of the list whose detail is read together, as
 * {@linkcode WindowedList.useBlocks | useBlocks} returns it. Every row in the block gets the same object, and passes it
 * to {@linkcode WindowedList.useItem | useItem}.
 */
export interface WindowedBlock<Params> {
    /** The list's params, passed to the detail read. */
    params: Params;
    /** The ids of the block's rows that need their detail read (rows that carry their own detail are left out). */
    ids: readonly string[];
}
/**
 * A long list whose rows need detail the list read doesn't carry, with that detail read in blocks of rows. Use
 * {@linkcode WindowedList.useList | useList} to read the list, call {@linkcode WindowedList.useBlocks | useBlocks} once
 * where the list renders, and call {@linkcode WindowedList.useItem | useItem} in each row with the block
 * {@linkcode WindowedList.useBlocks | useBlocks} gave it. A block's rows share one detail read, so a screen showing 50
 * rows makes about one read instead of 50.
 */
export interface WindowedList<Params, Row extends object, Detail> {
    /** The hook that reads the whole list: the spec's {@linkcode WindowedList.useList | useList}. */
    useList: (args: {
        /** The list read's args. */
        params: Params;
    } & ReadOptions) => DataResult<Row[]>;
    /**
     * A hook that divides the list's rows into blocks of {@linkcode WindowedListSpec.blockSize | blockSize} consecutive
     * rows, and returns a function giving a row its block. Call it once where the list renders, with the rows the list
     * shows, and call the returned function with each row and its index in `rows`. Blocks are built only as rows ask for
     * them. A row that isn't at the index given (or is given no index) gets a block of its own, and reads its detail
     * alone.
     */
    useBlocks: (args: {
        /** The list's params. */
        params: Params;
        /** The rows being rendered, in order. */
        rows: readonly Row[];
    }) => (row: Row, index?: number) => WindowedBlock<Params>;
    /**
     * A hook that returns one row's detail: what the row itself carries
     * ({@linkcode WindowedListSpec.prehydrated | prehydrated}), or else its entry in the detail read for its block,
     * `undefined` while that loads.
     */
    useItem: (args: {
        /** The row and its block. */
        params: {
            /** The row. */
            row: Row;
            /** The block {@linkcode WindowedList.useBlocks | useBlocks} gave the row. */
            block: WindowedBlock<Params>;
        };
    }) => Detail | undefined;
}
/**
 * A hook that returns one row's detail: `prehydrated` when the row carries it, or else the row's entry in the detail
 * read for its block's ids (`blockIds`, or just the row's own id when it has no block). `useDetailByIds` is called on
 * every render, with `enabled` false when the row already has its detail.
 */
export declare function useWindowedDetail<D>(prehydrated: D | undefined, id: string, blockIds: readonly string[] | undefined, useDetailByIds: (ids: readonly string[], enabled: boolean) => Record<string, D> | undefined): D | undefined;
/**
 * Creates a {@linkcode WindowedList}: a list read plus a per-row detail read done in blocks of consecutive rows, for a
 * virtualized list too long to load every row's detail, such as a ranking of thousands of players with a few dozen on
 * screen. Without blocks, every visible row would make its own detail read, with its own subscription and cache entry.
 */
export declare function createWindowedList<Params, Row extends object, Detail>(spec: WindowedListSpec<Params, Row, Detail>): WindowedList<Params, Row, Detail>;
//# sourceMappingURL=windowed_list.d.ts.map