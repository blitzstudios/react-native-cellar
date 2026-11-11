/**
 * Read snapshots, for an app that renders on a server: the server works out what a page's reads answer
 * ({@linkcode dehydrateReads}), and the browser renders those values ({@linkcode CellarHydrate}) until its own store
 * holds the rows, so the HTML and the browser's first render agree while the store is still being bound.
 */

import React, { useContext, useMemo } from 'react';

import { KEY_SEP } from '../key';
import { reportStoreDegradation } from '../diagnostics/telemetry';

/** One read's value as the server rendered it. */
export interface SnapshotEntry {
  /** The read's value. */
  readonly value: unknown;
  /** For a read across several partitions, which of them held rows, so `useEach` reports each one's state. */
  readonly present?: readonly boolean[];
  /** Set when the browser should fetch the read's partitions and move to live values once they land. */
  readonly live?: true;
}

/** What {@linkcode dehydrateReads} hands a page: each captured read's value, by the read and its args. Plain data. */
export interface ReadSnapshot {
  readonly reads: Readonly<Record<string, SnapshotEntry>>;
}

/** What capturing one read produces: its snapshot key and entry, or nothing when the read had nothing to answer. */
export type Captured = readonly [key: string, entry: SnapshotEntry] | undefined;

/** How a read's hook and getter expose the capture {@linkcode dehydrateReads} runs. Shared across copies of Cellar. */
export const CAPTURE: unique symbol = Symbol.for('cellar.read.capture') as never;

/** A read's hook or getter, as {@linkcode pairRead} publishes it, carrying its capture. */
export interface Capturable<Params> {
  readonly [CAPTURE]?: (params: Params, live: boolean) => Promise<Captured>;
}

/** One read to capture: its hook or getter, the params a component will call it with, and whether to go live. */
export interface ReadCall {
  readonly capture: () => Promise<Captured>;
  readonly label: string;
}

/** The key a snapshot files a read's value under: the read's name in its store, then the read's args key. */
export function snapshotKeyOf(readId: string, argsKey: string): string {
  return `${readId}${KEY_SEP}${argsKey}`;
}

/**
 * Names one read for {@linkcode dehydrateReads}: a service's hook or getter for it (`PlayerService.Hooks.usePlayer`),
 * and the params a component on the page will pass it. With `live`, the browser still fetches the read's partitions
 * and moves to the live value once they land; without it, the snapshot's value is the read's answer until something
 * else fetches the partition.
 */
export function readCall<Params>(
  read: ((args: { params: Params }) => unknown) & Capturable<Params>,
  params: Params,
  options?: { live?: boolean },
): ReadCall {
  const capture = read[CAPTURE];
  if (!capture) throw new Error('readCall: pass a read published with pairRead (a service hook or getter)');
  return { capture: () => capture(params, options?.live ?? false), label: read.name || 'a read' };
}

/**
 * Fetches each read's partitions if needed, waits for them, and returns what each read answers, as plain data a server
 * passes to {@linkcode CellarHydrate}. A read whose fetch fails is left out and reported, so its component renders as it
 * would with no snapshot: loading, then fetching in the browser.
 */
export async function dehydrateReads(calls: readonly ReadCall[]): Promise<ReadSnapshot> {
  const settled = await Promise.allSettled(calls.map((call) => call.capture()));
  const reads: Record<string, SnapshotEntry> = {};
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value) reads[result.value[0]] = result.value[1];
      return;
    }
    reportStoreDegradation({
      scope: 'hydration.capture',
      context: 'a read could not be captured for a server render, so the browser fetches it instead',
      error: result.reason,
      extra: { read: calls[index].label },
    });
  });
  return { reads };
}

type Entries = ReadonlyMap<string, SnapshotEntry>;

const CONTEXT = Symbol.for('cellar.read.hydration');
const registry = globalThis as unknown as Record<symbol, React.Context<Entries | undefined> | undefined>;

/**
 * One context however many copies of Cellar a server bundle loads, so a provider from one reaches a read from another.
 * Made on first use: a React Server Component imports this module under a React build with no `createContext`.
 */
function hydrationContext(): React.Context<Entries | undefined> {
  let context = registry[CONTEXT];
  if (!context) {
    context = React.createContext<Entries | undefined>(undefined);
    context.displayName = 'CellarHydrate';
    registry[CONTEXT] = context;
  }
  return context;
}

export interface CellarHydrateProps {
  /** What {@linkcode dehydrateReads} returned on the server. */
  snapshot: ReadSnapshot | undefined;
  children?: React.ReactNode;
}

/**
 * Makes a server's read snapshot available to the reads under it. A read finds its value here while its store has no
 * rows for it, on the server always, and in the browser until its partition lands. Nested providers add to the one
 * above, an inner entry winning.
 */
export function CellarHydrate({ snapshot, children }: CellarHydrateProps): React.ReactElement {
  const HydrationContext = hydrationContext();
  const outer = useContext(HydrationContext);
  const entries = useMemo(() => {
    const own = Object.entries(snapshot?.reads ?? {});
    if (!own.length) return outer;
    const merged = new Map(outer);
    for (const [key, entry] of own) merged.set(key, entry);
    return merged;
  }, [outer, snapshot]);
  return React.createElement(HydrationContext.Provider, { value: entries }, children);
}

/** The snapshot entry for one read call, if a {@linkcode CellarHydrate} above holds one; `readId` undefined looks up nothing. */
export function useHydrated(readId: string | undefined, argsKey: string): SnapshotEntry | undefined {
  const entries = useContext(hydrationContext());
  return readId && entries ? entries.get(snapshotKeyOf(readId, argsKey)) : undefined;
}
