"use strict";

/**
 * The version atom: how a store's reads learn about its writes. It keeps a version number for each partition (the set
 * of rows one fetch returns and replaces), and the version at which each entity in it last changed (an entity is the
 * thing a row belongs to, such as one player, named by the table's `entityId` column).
 *
 * A write "bumps" the partition with the entities it changed, which raises the numbers and notifies whoever is
 * listening to them. A read records which numbers it looked at, and re-runs when one of them moves: a read of named
 * entities only when those entities change, a read of the whole partition on any change.
 */

import { cacheKey, GROUP_SEP, cacheKeyOf } from "../args_key.js";
import { getOrCreate } from "../collections.js";
import { trackDependency } from "./tracking.js";
import { ALL_ENTITIES, isUnchanged } from "../table/change_set.js";
/**
 * Whether a partition key's parts name an actual partition: at least one part, and none of them empty. A key built from
 * args that are still missing a value has an empty part, and reads and fetches nothing.
 */
export const addressesPartition = parts => parts.length > 0 && parts.every(Boolean);

/** An empty, shared list of key parts, for a hook that must still run while its args name no partition yet. */
export const NO_PARTS = Object.freeze([]);

/** A partition's key together with its key parts (the key's values as a list of strings). */

/**
 * Pairs each partition key with its key parts, in the same order. Keys that name no partition (from args still missing
 * a value) are kept, so positions still line up with the list of keys.
 */
export function partitionEntries(keys, toParts) {
  return keys.map(key => ({
    key,
    parts: toParts(key)
  }));
}

/**
 * A store's version numbers: how its reads learn about its writes. Every method takes a partition's key parts (the
 * partition key's values as a list of strings). A partition is the set of rows one fetch returns and replaces; an
 * entity is the thing a row belongs to, such as one player, named by the table's `entityId` column.
 *
 * Each partition has three numbers, and reading one inside a tracking scope (a {@linkcode Read.useValue | useValue}
 * read, `useTrackedStores`, a tracked selector) makes the scope depend on it, so the scope re-runs when it changes:
 *
 * - {@linkcode VersionAtom.get | get}: the partition's version, which goes up on every write that changes anything in
 *   it. A read of the whole partition depends on this.
 * - {@linkcode VersionAtom.getEntity | getEntity}: the version at which one entity last changed. A read of particular
 *   entities
 *   depends on just those, so a write to other entities doesn't re-run it.
 * - {@linkcode VersionAtom.getPresence | getPresence}: goes up only when the partition may have gone from empty to
 *   having rows, or back: on its first write, and on any write that couldn't say which entities it changed. A read checks
 *   it to know whether there is anything to select from, without depending on every entity.
 */

/**
 * How many entities a partition remembers changing since its epoch. Past this, a write moves the epoch instead, which
 * counts every entity changed: safe, since it wakes readers rather than leaving them stale, and it keeps a long session
 * over a large partition from holding a version for every entity it ever touched.
 */
const ENTITY_MEMORY = 8192;

/**
 * Creates a store's {@linkcode VersionAtom}: the version numbers, per partition and per entity, that its reads depend
 * on and its writes bump. `root` names the store in each partition's dependency identity. {@linkcode defineSqliteStore}
 * creates one per store.
 */
export function createVersionAtom(root) {
  const specifier = parts => cacheKeyOf(parts);
  const key = parts => [root, specifier(parts)];
  const entries = new Map();
  const ensure = spec => getOrCreate(entries, spec, () => ({
    value: 0,
    epoch: 0,
    presence: 0,
    changedAt: new Map(),
    listeners: new Set(),
    entityListeners: new Map(),
    presenceListeners: new Set()
  }));
  const valueOf = spec => entries.get(spec)?.value ?? 0;
  const entityVersionOf = (spec, entityId) => {
    const entry = entries.get(spec);
    if (!entry) return 0;
    return Math.max(entry.epoch, entry.changedAt.get(entityId) ?? 0);
  };
  const presenceOf = spec => entries.get(spec)?.presence ?? 0;

  /**
   * Drops an entry nothing needs: never written, and nobody listening. A written entry must stay, since dropping it
   * resets its versions to 0, and a value cached at version 0 would then read as current.
   */
  const release = (spec, entry) => {
    if (entry.value !== 0 || entry.listeners.size || entry.entityListeners.size || entry.presenceListeners.size) return;
    if (entries.get(spec) !== entry) return;
    entries.delete(spec);
    // The descriptors follow the entry. One already handed to a sink keeps working, since it reads `entries` through
    // its spec on each call, and the next read rebuilds an identical one.
    partitionDeps.delete(spec);
    entityDeps.delete(spec);
    presenceDeps.delete(spec);
  };
  const listen = (spec, pick, listener) => {
    const entry = ensure(spec);
    const set = pick(entry);
    set.add(listener);
    return () => {
      set.delete(listener);
      release(spec, entry);
    };
  };
  const subscribeEntity = (spec, entityId, listener) => {
    const entry = ensure(spec);
    const set = getOrCreate(entry.entityListeners, entityId, () => new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size && entry.entityListeners.get(entityId) === set) entry.entityListeners.delete(entityId);
      release(spec, entry);
    };
  };

  /**
   * One descriptor per partition, per entity and per presence, rather than one per read: {@linkcode trackDependency}
   * dedupes by id and only ever reads the descriptor, so a shared instance behaves the same as a fresh one and costs
   * nothing to report again. Held apart from `entries`, since reading must not create an entry: that would widen what
   * {@linkcode VersionAtom.bumpAll | bumpAll} bumps.
   */
  const partitionDeps = new Map();
  const entityDeps = new Map();
  const presenceDeps = new Map();
  const partitionDep = spec => getOrCreate(partitionDeps, spec, () => ({
    id: cacheKey(root, spec),
    subscribe: listener => listen(spec, entry => entry.listeners, listener),
    getVersion: () => valueOf(spec)
  }));
  // An entity's id extends its partition's with a separator no part or entity carries, and presence doubles it, so none
  // of the three can collide with another.
  const entityDep = (spec, entityId) => getOrCreate(getOrCreate(entityDeps, spec, () => new Map()), entityId, () => ({
    id: `${cacheKey(root, spec)}${GROUP_SEP}${entityId}`,
    subscribe: listener => subscribeEntity(spec, entityId, listener),
    getVersion: () => entityVersionOf(spec, entityId)
  }));
  const presenceDep = spec => getOrCreate(presenceDeps, spec, () => ({
    id: `${cacheKey(root, spec)}${GROUP_SEP}${GROUP_SEP}`,
    subscribe: listener => listen(spec, entry => entry.presenceListeners, listener),
    getVersion: () => presenceOf(spec)
  }));
  const get = parts => {
    const spec = specifier(parts);
    trackDependency(partitionDep(spec));
    return valueOf(spec);
  };
  const getEntity = (parts, entityId) => {
    const spec = specifier(parts);
    trackDependency(entityDep(spec, entityId));
    return entityVersionOf(spec, entityId);
  };
  const getPresence = parts => {
    const spec = specifier(parts);
    trackDependency(presenceDep(spec));
    return presenceOf(spec);
  };

  /**
   * Raises the version and wakes exactly the listeners the write concerns: every partition listener, and the listeners
   * of the entities that changed — all of them when the write could not say which. A listener subscribed to several of
   * the changed entities is called once. Synchronous; ingest bumps inside `notifyManager.batch` so re-renders coalesce.
   */
  const bumpSpec = (spec, changes) => {
    if (isUnchanged(changes)) return valueOf(spec);
    const entry = ensure(spec);
    const firstWrite = entry.value === 0;
    entry.value += 1;
    let effective = changes;
    if (changes === ALL_ENTITIES || firstWrite || entry.changedAt.size + changes.size > ENTITY_MEMORY) {
      entry.epoch = entry.value;
      entry.changedAt.clear();
      effective = ALL_ENTITIES;
    } else {
      for (const entityId of changes) entry.changedAt.set(entityId, entry.value);
    }
    const wake = new Set(entry.listeners);
    if (effective === ALL_ENTITIES) {
      entry.presence += 1;
      for (const listener of entry.presenceListeners) wake.add(listener);
      for (const set of entry.entityListeners.values()) for (const listener of set) wake.add(listener);
    } else {
      for (const entityId of effective) {
        const set = entry.entityListeners.get(entityId);
        if (set) for (const listener of set) wake.add(listener);
      }
    }
    wake.forEach(listener => listener());
    return entry.value;
  };
  const bump = (parts, changes = ALL_ENTITIES) => bumpSpec(specifier(parts), changes);

  // Snapshotted first: a listener may write, and writing bumps, which mutates the map mid-walk.
  const bumpAll = () => Array.from(entries.keys()).forEach(spec => bumpSpec(spec, ALL_ENTITIES));
  const subscribe = (parts, listener) => listen(specifier(parts), entry => entry.listeners, listener);
  const atom = {
    key,
    get,
    getEntity,
    getPresence,
    bump,
    bumpAll,
    subscribe
  };
  entityLogs.set(atom, parts => {
    const entry = entries.get(specifier(parts));
    return {
      epoch: entry?.epoch ?? 0,
      changed: entry ? Array.from(entry.changedAt, ([id, version]) => ({
        id,
        version
      })) : []
    };
  });
  return atom;
}

/** What each atom remembers of a partition's entity changes, read without tracking, for the inspector. */
const entityLogs = new WeakMap();

/** The entities that changed in a partition since every entity last counted as changed. */

/** The partition's entity changes as `atom` remembers them; empty for an atom {@linkcode createVersionAtom} didn't make. */
export function entityChangesOf(atom, parts) {
  return entityLogs.get(atom)?.(parts) ?? {
    epoch: 0,
    changed: []
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=version_atom.js.map