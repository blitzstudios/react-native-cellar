"use strict";

/**
 * Read snapshots, for an app that renders on a server: the server works out what a page's reads answer
 * ({@linkcode dehydrateReads}), and the browser renders those values ({@linkcode CellarHydrate}) until its own store
 * holds the rows, so the HTML and the browser's first render agree while the store is still being bound.
 */

import React, { useContext, useMemo } from 'react';
import { KEY_SEP } from "../key.js";
import { reportStoreDegradation } from "../diagnostics/telemetry.js";

/** One read's value as the server rendered it. */

/** What {@linkcode dehydrateReads} hands a page: each captured read's value, by the read and its args. Plain data. */

/** What capturing one read produces: its snapshot key and entry, or nothing when the read had nothing to answer. */

/** How a read's hook and getter expose the capture {@linkcode dehydrateReads} runs. Shared across copies of Cellar. */
export const CAPTURE = Symbol.for('cellar.read.capture');

/** A read's hook or getter, as {@linkcode pairRead} publishes it, carrying its capture. */

/** One read to capture: its hook or getter, the params a component will call it with, and whether to go live. */

/** The key a snapshot files a read's value under: the read's name in its store, then the read's args key. */
export function snapshotKeyOf(readId, argsKey) {
  return `${readId}${KEY_SEP}${argsKey}`;
}

/**
 * Names one read for {@linkcode dehydrateReads}: a service's hook or getter for it (`PlayerService.Hooks.usePlayer`),
 * and the params a component on the page will pass it. With `live`, the browser still fetches the read's partitions
 * and moves to the live value once they land; without it, the snapshot's value is the read's answer until something
 * else fetches the partition.
 */
export function readCall(read, params, options) {
  const capture = read[CAPTURE];
  if (!capture) throw new Error('readCall: pass a read published with pairRead (a service hook or getter)');
  return {
    capture: () => capture(params, options?.live ?? false),
    label: read.name || 'a read'
  };
}

/**
 * Fetches each read's partitions if needed, waits for them, and returns what each read answers, as plain data a server
 * passes to {@linkcode CellarHydrate}. A read whose fetch fails is left out and reported, so its component renders as it
 * would with no snapshot: loading, then fetching in the browser.
 */
export async function dehydrateReads(calls) {
  const settled = await Promise.allSettled(calls.map(call => call.capture()));
  const reads = {};
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value) reads[result.value[0]] = result.value[1];
      return;
    }
    reportStoreDegradation({
      scope: 'hydration.capture',
      context: 'a read could not be captured for a server render, so the browser fetches it instead',
      error: result.reason,
      extra: {
        read: calls[index].label
      }
    });
  });
  return {
    reads
  };
}
const CONTEXT = Symbol.for('cellar.read.hydration');
const registry = globalThis;

/**
 * One context however many copies of Cellar a server bundle loads, so a provider from one reaches a read from another.
 * Made on first use: a React Server Component imports this module under a React build with no `createContext`.
 */
function hydrationContext() {
  let context = registry[CONTEXT];
  if (!context) {
    context = /*#__PURE__*/React.createContext(undefined);
    context.displayName = 'CellarHydrate';
    registry[CONTEXT] = context;
  }
  return context;
}
/**
 * Makes a server's read snapshot available to the reads under it. A read finds its value here while its store has no
 * rows for it, on the server always, and in the browser until its partition lands. Nested providers add to the one
 * above, an inner entry winning.
 */
export function CellarHydrate({
  snapshot,
  children
}) {
  const HydrationContext = hydrationContext();
  const outer = useContext(HydrationContext);
  const entries = useMemo(() => {
    const own = Object.entries(snapshot?.reads ?? {});
    if (!own.length) return outer;
    const merged = new Map(outer);
    for (const [key, entry] of own) merged.set(key, entry);
    return merged;
  }, [outer, snapshot]);
  return /*#__PURE__*/React.createElement(HydrationContext.Provider, {
    value: entries
  }, children);
}

/** The snapshot entry for one read call, if a {@linkcode CellarHydrate} above holds one; `readId` undefined looks up nothing. */
export function useHydrated(readId, argsKey) {
  const entries = useContext(hydrationContext());
  return readId && entries ? entries.get(snapshotKeyOf(readId, argsKey)) : undefined;
}
//# sourceMappingURL=hydration.js.map