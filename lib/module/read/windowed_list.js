"use strict";

/**
 * A windowed list: a long list read, plus a detail read for each row that is done in blocks of rows rather than one row
 * at a time. Every row in a block calls the detail read with the block's ids, so the block's rows share one cached read
 * and one fetch, however many of them render.
 */

import { useMemo } from 'react';
import { getOrCreate } from "../collections.js";
const EMPTY_IDS = [];

/** The reads and functions a {@linkcode createWindowedList} is built from. */

/**
 * A block: consecutive rows of the list whose detail is read together, as
 * {@linkcode WindowedList.useBlocks | useBlocks} returns it. Every row in the block gets the same object, and passes it
 * to {@linkcode WindowedList.useItem | useItem}.
 */

/**
 * A long list whose rows need detail the list read doesn't carry, with that detail read in blocks of rows. Use
 * {@linkcode WindowedList.useList | useList} to read the list, call {@linkcode WindowedList.useBlocks | useBlocks} once
 * where the list renders, and call {@linkcode WindowedList.useItem | useItem} in each row with the block
 * {@linkcode WindowedList.useBlocks | useBlocks} gave it. A block's rows share one detail read, so a screen showing 50
 * rows makes about one read instead of 50.
 */

/**
 * A hook that returns one row's detail: `prehydrated` when the row carries it, or else the row's entry in the detail
 * read for its block's ids (`blockIds`, or just the row's own id when it has no block). `useDetailByIds` is called on
 * every render, with `enabled` false when the row already has its detail.
 */
export function useWindowedDetail(prehydrated, id, blockIds, useDetailByIds) {
  // Nullish, not falsy: a `Detail` of `0` or `''` is a value the list carried. Must match the return below.
  const need = prehydrated == null;
  const ids = useMemo(() => need ? blockIds ?? [id] : EMPTY_IDS, [need, blockIds, id]);
  const detail = useDetailByIds(ids, need);
  return prehydrated ?? detail?.[id];
}

/**
 * Creates a {@linkcode WindowedList}: a list read plus a per-row detail read done in blocks of consecutive rows, for a
 * virtualized list too long to load every row's detail, such as a ranking of thousands of players with a few dozen on
 * screen. Without blocks, every visible row would make its own detail read, with its own subscription and cache entry.
 */
export function createWindowedList(spec) {
  const blockSize = spec.blockSize ?? 50;
  function useList(args) {
    return spec.useList(args);
  }
  function useBlocks({
    params,
    rows
  }) {
    return useMemo(() => {
      // Keyed by block start rather than by row, and filled as rows ask. A virtualized list hands `rows` the whole
      // collection but renders a window of it, so building a block per row up front sized this with the collection
      // -- thousands of map entries and a copy of every row -- to answer for the few dozen on screen.
      const blocks = new Map();
      // A row outside `rows` gets a block of its own, cached so it too keeps one block identity across renders.
      const alone = new Map();
      const soloFor = row => getOrCreate(alone, row, () => ({
        params,
        ids: [spec.idOf(row)]
      }));
      return (row, index = -1) => {
        // The index is the caller's claim about where the row sits; anything it does not identify is treated as a row
        // `rows` never covered, which is what an out-of-range or omitted index means.
        if (rows[index] !== row) return soloFor(row);
        const start = index - index % blockSize;
        return getOrCreate(blocks, start, () => {
          const end = Math.min(start + blockSize, rows.length);
          // Hydrate only the rows still missing their detail.
          const ids = [];
          for (let at = start; at < end; at++) {
            const member = rows[at];
            if (!spec.prehydrated(member)) ids.push(spec.idOf(member));
          }
          return {
            params,
            ids
          };
        });
      };
    }, [params, rows]);
  }
  function useItem({
    params
  }) {
    const {
      row,
      block
    } = params;
    const useDetailByIds = (ids, enabled) => spec.useDetailByIds(block.params, ids, enabled);
    return useWindowedDetail(spec.prehydrated(row), spec.idOf(row), block.ids, useDetailByIds);
  }
  return {
    useList,
    useBlocks,
    useItem
  };
}
//# sourceMappingURL=windowed_list.js.map