"use strict";

/**
 * Reads: how a store turns a read definition into a hook ({@linkcode Read.useValue | useValue}) and a getter
 * ({@linkcode Read.getValue | getValue}).
 *
 * A read names a partition with its args (a partition is the set of rows one fetch returns and replaces), fetches the
 * partition if it has never been fetched, and runs the read's {@linkcode ReadDef.select | select} over the partition's
 * rows to compute its value. It declares none of its args: it is ready once every arg its caller passed has a value,
 * and what it depends on is found by running it. A read caches nothing itself: {@linkcode ReadDef.select | select}
 * returns values from the store's caches (declared in {@linkcode Partitions.defineCaches | defineCaches}), the hook runs
 * it again only when its args or something it read changes, and re-renders its component only when the new value
 * differs.
 */

import { useCallback, useMemo } from 'react';
import { argsKeyOf, cacheKeyOf, KEY_SEP, partitionsKey } from "../args_key.js";
import { getOrCreate } from "../collections.js";
import { partitionKeyOf } from "./partition_fields.js";
import { ArgNotPassed, createArgsView } from "./args_view.js";
import { createBoundedLru, createVersionedCache, shallowEqualValue } from "../caches.js";
import { addressesPartition, NO_PARTS, partitionEntries } from "../reactivity/version_atom.js";
import { createOnceGuard, onGuardReset } from "../diagnostics/once_guard.js";
import { shouldLog } from "../diagnostics/log_level.js";
import { NO_PRIMING } from "../prime_state.js";
import { makeResult, offHeapStatus } from "../store_result.js";
import { runSubscribed, runTracked, trackDependency } from "../reactivity/tracking.js";
import { useTrackedValue } from "../reactivity/tracked_value.js";
import { covered, uncoveredReads } from "../table/read_coverage.js";

/**
 * The parts of a store's fetch ingest that its reads use: the hooks that fetch partitions, and imperative fetch starts.
 */

/**
 * What a store's reads need from the store: its version atom, how a partition key becomes its version key, whether a
 * partition has rows or has been fetched, and the fetch ingest. {@linkcode definePartitions} builds this for each
 * store.
 */

/**
 * The args a read's functions see ({@linkcode ReadDef.select | select}, its partition, {@linkcode CommonDef.enabled |
 * enabled}): every field non-null, since a read runs only once each arg it was handed has a value, and reading one it
 * wasn't handed stops the function before it sees `undefined`. The fields in `Optional`, the read's
 * {@linkcode CommonDef.optionalArgs | optionalArgs}, keep their `undefined`.
 */

/**
 * The fields every kind of read definition shares ({@linkcode Partitions.defineRead | defineRead},
 * {@linkcode Partitions.defineReadMany | defineReadMany} and
 * {@linkcode Partitions.defineReadGrouped | defineReadGrouped}).
 *
 * A read declares none of its args. It is ready once every arg its caller passed has a value (`undefined`, `null`,
 * `''` and an empty list count as none; `0` and `false` are values); until then it returns
 * {@linkcode CommonDef.empty | empty}, fetches nothing and runs nothing. A hook runs
 * {@linkcode ReadDef.select | select} again when its args change, compared by content, or when something it read
 * changes. A function of the read that reads an arg the caller didn't pass at all stops, and the read returns
 * {@linkcode CommonDef.empty | empty} as though it weren't ready.
 */

/**
 * The definition of a read of one partition. The args name one partition (through
 * {@linkcode ReadDef.partition | partition}, or the store's key by default); the read fetches it if it has never been
 * fetched, and {@linkcode ReadDef.select | select} computes the value from its rows. Nearly every read is this kind.
 * For a read across several partitions, use {@linkcode ReadManyDef}; for several lookups at once, each with its own
 * candidate partitions, use {@linkcode ReadGroupedDef}.
 */

/**
 * The definition of a read across several partitions, fetched and subscribed to together and computed into one value,
 * such as one player's stat rows across several weeks, one partition per week. {@linkcode ReadManyDef.select | select}
 * gets the partition keys as one flat list. For several lookups at once, each with its own candidate partitions, use
 * {@linkcode ReadGroupedDef}.
 */

/**
 * The definition of a read that answers several lookups at once, where each lookup's rows could be in any of several
 * candidate partitions, such as a stat row for each of several stat keys, where each key could be in more than one
 * partition. {@linkcode ReadGroupedDef.groups | groups} gives each lookup's candidate partitions; all of them are
 * fetched and subscribed to; {@linkcode ReadGroupedDef.select | select} gets the groups back in the same order, so it
 * can answer each lookup from its own candidates.
 */

/**
 * Options one caller passes to a read's {@linkcode Read.useValue | useValue} hook, on top of what the read's definition
 * fixes. They apply to that call only.
 */

/**
 * A declared read, as a store's {@linkcode StoreSurface.reads | reads} hold it: a hook
 * ({@linkcode Read.useValue | useValue}) and a getter ({@linkcode Read.getValue | getValue}) that return the same
 * value. Both take the read's args, or `undefined` when the caller doesn't have them yet, which returns
 * {@linkcode CommonDef.empty | empty}.
 */

/** Each read's name in its store's {@linkcode StoreSurface.reads | reads}, for dev warnings about that read. */
const readLabels = new WeakMap();

/** Names a store's reads by their keys in its {@linkcode StoreSurface.reads | reads}, so warnings can say which read. */
export function labelReads(reads) {
  for (const [name, read] of Object.entries(reads)) if (read && typeof read === 'object') readLabels.set(read, name);
}

/** Stable identities so a disabled read's hooks keep the same deps across renders. */
const NO_KEYS = Object.freeze([]);
const NO_GROUPS = Object.freeze([]);
const NO_PARTITIONS = Object.freeze([]);
const NO_ARGS_KEY = `${KEY_SEP}disabled`;

/** Above one viewport's worth of rows: a virtualized list self-limits around 20-30. */
const FANOUT_WARN_THRESHOLD = 48;

/** Entries in a surface's presence cache, which is keyed by partition and so bounds live partitions. */
const PRESENCE_CACHE_MAX = 512;
const fanoutWarned = createOnceGuard();
let fanoutTick = null;
onGuardReset(() => {
  fanoutTick = null;
});
function flushFanout() {
  const tick = fanoutTick;
  fanoutTick = null;
  if (!shouldLog('warn')) return;
  tick?.forEach((entry, store) => {
    if (entry.keys.size <= FANOUT_WARN_THRESHOLD || fanoutWarned.seen(store)) return;
    const sample = [...entry.keys].slice(0, 3).join(', ');
    // Already-batched callers need the opposite advice from per-row ones: telling a list that reads five ids a row
    // to "use a plural read" describes what it is doing, and it stops reading the warning.
    const remedy = entry.batched ? 'These reads are already plural, so the fix is not a plural read but one read higher up: lift it to the ' + "parent over the union of what its rows ask for, and let each row index into that result. If the rows' " + 'sets come from a list the parent already holds, `createWindowedList` resolves them against it.' : 'A list is reading per row, which puts one subscription and one hydration on the heap per row. Read the ' + "set once in the parent — a plural `*ByIds` read, or `createWindowedList` so rows resolve against the " + "parent's list — and let each row index into that.";
    // eslint-disable-next-line no-console
    console.warn(`[${store}_store] ${entry.keys.size} separate reads in one tick (e.g. ${sample}). ${remedy} Note that a ` + 'plural read still primes by PARTITION, not by the ids it asks for, so if this partition is coarse the ' + 'parent read fetches all of it either way and this is about subscriptions rather than fetching; where the ' + 'rows are already to hand from the payload that listed them, prefer rendering from those and declaring ' + '`prime: false`.');
  });
}

/**
 * `batchSize` is the widest list a call passes, so a caller already asking for a set can be told something else.
 */
function noteRead(store, argsKey, batchSize) {
  if (fanoutWarned.has(store)) return;
  if (!fanoutTick) {
    fanoutTick = new Map();
    setTimeout(flushFanout, 0);
  }
  const entry = getOrCreate(fanoutTick, store, () => ({
    keys: new Set(),
    batched: false
  }));
  entry.keys.add(argsKey);
  if (batchSize > 1) entry.batched = true;
}

/** The widest list among a call's args: 1 when it names one thing, which is the per-row shape the warning is for. */
function batchSizeOf(args) {
  let widest = 1;
  for (const value of Object.values(args)) if (Array.isArray(value) && value.length > widest) widest = value.length;
  return widest;
}

/** Returns a {@linkcode DataResult} whose identity is stable across renders while its parts hold. */
export function useResult(data, status, isFetching, doRefetch) {
  return useMemo(() => makeResult(data, status, {
    isFetching,
    refetch: doRefetch
  }), [data, status, isFetching, doRefetch]);
}
const SELECTS_SLICE = {
  slice: true
};

/**
 * What a call wants of the partitions it primes: part of them when it passes an arg that naming them didn't read, the
 * way a read of one player passes a player id beside its sport. That is the only shape where an oversized fetch is
 * worth reporting; a call passing nothing else is asking for the partition.
 */
function intentOf(args, naming) {
  for (const field of Object.keys(args)) if (!naming.has(field)) return SELECTS_SLICE;
  return undefined;
}

/**
 * Whether a read may prime its partitions and whether its {@linkcode ReadDef.select | select} may run. Priming asks
 * strictly less: a read its {@linkcode CommonDef.enabled | enabled} turns off still primes, since that marks an arg
 * naming nothing rather than a partition nobody wants.
 */
function readGates(prime, addressable, primeWanted, enabled) {
  return {
    // Both the declaration and the call site can veto priming, and neither can override the other: a read that
    // declares `prime: false` never fetches, and a caller passing `prime: false` never fetches, whoever else does.
    prime: addressable && primeWanted && (prime ?? true),
    read: addressable && enabled()
  };
}

/**
 * The status and {@linkcode DataResult} every read ends with; `hasData` is a thunk, called once the read is known
 * enabled.
 */
function useReadTail(data, enabled, hasData, prime, doRefetch) {
  const status = runSubscribed(() => offHeapStatus(enabled, enabled && hasData(), prime));
  return useResult(data, status, prime.isFetching, doRefetch);
}

/** What a read's `select` returned when it stopped on an arg its caller didn't pass. */
const WAITING = Symbol('waiting on an arg');

/** How many times one call may build the same value from rows no cache holds before the read is warned about. */
const UNCACHED_REPEATS_WARN_AT = 3;
const uncachedWarned = createOnceGuard();
const notPassedWarned = createOnceGuard();

/**
 * Builds the read engine over one store's partitions: {@linkcode Partitions.defineRead | defineRead} /
 * {@linkcode Partitions.defineReadMany | defineReadMany} / {@linkcode Partitions.defineReadGrouped | defineReadGrouped}
 * each take a descriptor and hand back its {@linkcode Read.useValue | useValue} / {@linkcode Read.getValue | getValue}
 * pair, with the readiness gate, the priming, the version subscription and the presence gate already wrapped around
 * {@linkcode ReadDef.select | select}. {@linkcode definePartitions} builds one per store, so stores declare reads.
 */
export function createReadSurface(kernel) {
  const {
    ingest,
    toParts
  } = kernel;
  const store = kernel.name ?? 'off_heap';
  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /** Whether each partition holds rows, keyed by partition and shared by every read on this surface. */
  const presenceByVersion = createVersionedCache(PRESENCE_CACHE_MAX);
  // Held against the presence version, which moves only on a write that could have emptied or filled the partition,
  // and tracks presence alone: a read of one entity must not come to depend on the whole partition by asking this.
  const hasOne = (key, parts) => presenceByVersion.read(cacheKeyOf(parts), kernel.version.getPresence(parts), () => covered(() => kernel.has(key)));
  const hasAny = entries => entries.some(entry => addressesPartition(entry.parts) && hasOne(entry.key, entry.parts));

  /**
   * Starts an unfetched partition's fetch. Only {@linkcode Read.getValue | getValue} needs it; a reactive read primes
   * through {@linkcode PartitionLifecycle.usePrime | usePrime}. Cold means never fetched, not empty: a partition
   * holding rows a socket pushed into it has never had its body, and gating on rows would leave it on that one row for
   * the session.
   */
  const primeIfCold = (key, parts) => {
    if (!ingest) return;
    const fetched = kernel.hasFetched ? kernel.hasFetched(key) : hasOne(key, parts);
    if (!fetched) ingest.ensure(key);
  };

  /** Presence of every partition named, which is what a read reports when it has nothing else to depend on. */
  const trackPresence = partitions => {
    for (const parts of partitions) if (addressesPartition(parts)) kernel.version.getPresence(parts);
  };

  /**
   * Everything one read does around its functions: seeing its args through its view, running
   * {@linkcode ReadDef.select | select} so its result depends on enough, and, in dev, noticing a select that keeps
   * building the same value from rows no cache holds.
   */
  const readRunner = optional => {
    const view = createArgsView(optional);
    const repeats = __DEV__ ? createBoundedLru(64) : undefined;
    let self;
    const label = () => (self && readLabels.get(self)) ?? 'a read';
    const noteNotPassed = field => {
      if (!__DEV__ || notPassedWarned.seen(store, label(), field)) return;
      // eslint-disable-next-line no-console
      console.warn(`[${store}_store] \`${label()}\` read the arg \`${field}\`, which its caller didn't pass, so it returns its empty ` + "value until the caller passes one. Pass it, as `null` while it isn't known yet, or name it in the read's `optionalArgs`.");
    };
    const noteUncached = (argsKey, partitions) => {
      if (!repeats || uncachedWarned.has(store, label())) return;
      // Read in a scope of its own, so taking the stamp doesn't subscribe the caller to anything more.
      const stamp = runTracked(() => partitions.map(parts => addressesPartition(parts) ? kernel.version.get(parts) : '').join(',')).value;
      const held = repeats.get(argsKey);
      const count = held && held.stamp === stamp ? held.count + 1 : 1;
      repeats.set(argsKey, {
        stamp,
        count
      });
      if (count < UNCACHED_REPEATS_WARN_AT || uncachedWarned.seen(store, label())) return;
      // eslint-disable-next-line no-console
      console.warn(`[${store}_store] \`${label()}\` built its value from rows no cache holds ${count} times for the same args and ` + 'the same rows: a read keeps nothing, so every subscriber and every getValue call builds it again. Build it ' + "inside a cache in the store's defineCaches block (a byPartition cache keyed by what varies), or leave it " + 'uncached on purpose if one screen holds it.');
    };
    return {
      view,
      bind: read => {
        self = read;
      },
      /**
       * Runs `fn` (a read's `select`, over its args) and makes sure the result depends on enough. A `select` built
       * from caches reports what it read and depends on that alone. One that read rows straight off the table, or
       * reported nothing at all, is made to depend on every partition it named: it could have read anything in them.
       * One that stopped on an arg its caller didn't pass depends on presence alone, and returns {@linkcode WAITING}.
       */
      select(partitions, argsKey, fn) {
        const before = uncoveredReads();
        let result;
        try {
          result = runTracked(fn);
        } catch (error) {
          if (!(error instanceof ArgNotPassed)) throw error;
          noteNotPassed(error.field);
          trackPresence(partitions);
          return WAITING;
        }
        for (const dep of result.deps) trackDependency(dep);
        const uncovered = uncoveredReads() !== before;
        if (!result.deps.length || uncovered) for (const parts of partitions) if (addressesPartition(parts)) kernel.version.get(parts);
        if (__DEV__ && uncovered) noteUncached(argsKey(), partitions);
        return result.value;
      },
      /** Whether `enabled` lets the read run; an `enabled` that reads an arg its caller didn't pass doesn't. */
      enabled: (args, enabled) => {
        if (!enabled) return true;
        try {
          return view.run(args, enabled);
        } catch (error) {
          if (error instanceof ArgNotPassed) return false;
          throw error;
        }
      }
    };
  };
  function defineRead(def) {
    const spec = def.partition ?? kernel.defaultPartition;
    if (!spec) throw new Error(`${store}_store: this read needs a \`partition\`, since the store's key declares no \`fields\` to default to`);
    const keyOf = partitionKeyOf(spec);
    const runner = readRunner(def.optionalArgs);
    const {
      view
    } = runner;

    /** Where a call stands: waiting, or ready with its partition and what it wants of it. */
    const resolve = args => {
      if (args === undefined || !view.ready(args)) return undefined;
      try {
        const {
          value: key,
          read
        } = view.record(args, keyOf);
        return {
          key,
          parts: toParts(key),
          intent: intentOf(args, read)
        };
      } catch (error) {
        if (error instanceof ArgNotPassed) return undefined;
        throw error;
      }
    };
    const gatesFor = (args, parts, wanted, primeWanted = true) => readGates(def.prime, wanted && addressesPartition(parts), primeWanted, () => runner.enabled(args, def.enabled));
    const run = (args, key, parts, argsKey) => {
      const value = runner.select([parts], argsKey, () => view.run(args, ready => def.select(ready, key)));
      return value === WAITING ? def.empty : value;
    };
    function getValue(args) {
      const call = resolve(args);
      if (!call || !addressesPartition(call.parts)) return def.empty;
      const {
        key,
        parts
      } = call;
      const gates = gatesFor(args, parts, true);
      if (gates.prime) primeIfCold(key, parts);
      // Every path reports something to the scope above it, so a derivation that got `empty` here still hears when
      // the partition lands: presence for a disabled or cold read, and whatever `select` read otherwise.
      if (!gates.read) {
        kernel.version.getPresence(parts);
        return def.empty;
      }
      if (!hasOne(key, parts)) return def.empty;
      return run(args, key, parts, () => argsKeyOf(parts, args));
    }
    function useValue(args, options) {
      // A call that isn't ready addresses nothing; the hooks below still run, reading nothing.
      const call = resolve(args);
      const key = call?.key;
      const parts = call ? call.parts : NO_PARTS;
      const gates = gatesFor(args, parts, (options?.enabled ?? true) && call !== undefined, options?.prime ?? true);
      const prime = usePriming(key, gates.prime, call?.intent);
      const argsKey = call ? argsKeyOf(parts, args) : NO_ARGS_KEY;
      if (__DEV__ && gates.read) noteRead(store, argsKey, batchSizeOf(args));
      const data = useTrackedValue(() => hasOne(key, parts) ? run(args, key, parts, () => argsKey) : def.empty, [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? shallowEqualValue,
        empty: def.empty
      });
      const doRefetch = useCallback(() => {
        if (key !== undefined) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `key`
      return useReadTail(data, gates.read, () => addressesPartition(parts) && hasOne(key, parts), prime, doRefetch);
    }
    const read = {
      getValue,
      useValue
    };
    runner.bind(read);
    return read;
  }

  /**
   * The engine behind {@linkcode Partitions.defineReadMany | defineReadMany} and
   * {@linkcode Partitions.defineReadGrouped | defineReadGrouped}, which differ only in what `select` is handed back:
   * the flat keys, or the groups they were named in. `resolve` runs once per call because naming a partition may intern
   * it.
   */
  function manyRead(def, name, select, noneNamed) {
    const runner = readRunner(def.optionalArgs);
    const {
      view
    } = runner;
    const partitionsArgsKey = (partitions, args) => argsKeyOf([partitionsKey(partitions)], args);

    /** Where a call stands: waiting, or ready with its partitions, what it named them as, and what it wants of them. */
    const resolve = args => {
      if (args === undefined || !view.ready(args)) return undefined;
      try {
        const {
          value,
          read
        } = view.record(args, name);
        const entries = partitionEntries(value.keys, toParts);
        return {
          ...value,
          entries,
          partitions: entries.map(entry => entry.parts),
          intent: intentOf(args, read)
        };
      } catch (error) {
        if (error instanceof ArgNotPassed) return undefined;
        throw error;
      }
    };

    /**
     * {@linkcode Partitions.defineRead | defineRead}'s gates over a set: addressable when at least one partition is,
     * since the rest are gaps.
     */
    const gatesFor = (args, partitions, wanted, primeWanted = true) => readGates(def.prime, wanted && partitions.some(addressesPartition), primeWanted, () => runner.enabled(args, def.enabled));
    const run = (args, named, partitions, argsKey) => {
      const value = runner.select(partitions, argsKey, () => view.run(args, ready => select(ready, named)));
      return value === WAITING ? def.empty : value;
    };
    function getValue(args) {
      const call = resolve(args);
      if (!call) return def.empty;
      const gates = gatesFor(args, call.partitions, true);
      if (gates.prime) for (const entry of call.entries) if (addressesPartition(entry.parts)) primeIfCold(entry.key, entry.parts);
      // `hasAny` stops at the first partition holding rows, so the rest are reported here for a read that lands later.
      trackPresence(call.partitions);
      if (!gates.read || !hasAny(call.entries)) return def.empty;
      return run(args, call.named, call.partitions, () => partitionsArgsKey(call.partitions, args));
    }
    function useValue(args, options) {
      const call = resolve(args);
      const keys = call ? call.keys : NO_KEYS;
      const entries = call ? call.entries : [];
      const partitions = call ? call.partitions : NO_PARTITIONS;
      const gates = gatesFor(args, partitions, (options?.enabled ?? true) && call !== undefined, options?.prime ?? true);
      const prime = usePrimingAll(keys, gates.prime, call?.intent);
      const argsKey = call ? partitionsArgsKey(partitions, args) : NO_ARGS_KEY;
      const data = useTrackedValue(() => {
        trackPresence(partitions);
        return hasAny(entries) ? run(args, call ? call.named : noneNamed, partitions, () => argsKey) : def.empty;
      }, [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? shallowEqualValue,
        empty: def.empty
      });
      const doRefetch = useCallback(() => {
        for (const key of keys) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `keys`
      return useReadTail(data, gates.read, () => hasAny(entries), prime, doRefetch);
    }
    const read = {
      getValue,
      useValue
    };
    runner.bind(read);
    return read;
  }
  function defineReadMany(def) {
    const name = args => {
      const keys = def.partitions(args);
      return {
        keys,
        named: keys
      };
    };
    return manyRead(def, name, def.select, NO_KEYS);
  }
  function defineReadGrouped(def) {
    const name = args => {
      const named = def.groups(args);
      const keys = [];
      for (const group of named) for (const key of group) keys.push(key);
      return {
        keys,
        named
      };
    };
    return manyRead(def, name, def.select, NO_GROUPS);
  }

  /** The surface's cached presence probe, so a store asks the same question the reads gate on. */
  const has = key => hasOne(key, toParts(key));
  return {
    /**
     * Declares a read: `read<Args, Value>({ … })`, or `read<Args, Value, 'optionalArg'>({ optionalArgs: ['optionalArg'],
     * … })` for a read that may be handed an arg without a value.
     */
    read: defineRead,
    readMany: defineReadMany,
    readGrouped: defineReadGrouped,
    has
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=surface.js.map