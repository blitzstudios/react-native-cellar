/**
 * The version atom: how a store's reads learn about its writes. It keeps a version number for each partition (the set
 * of rows one fetch returns and replaces), and the version at which each entity in it last changed (an entity is the
 * thing a row belongs to, such as one player, named by the table's `entityId` column).
 *
 * A write "bumps" the partition with the entities it changed, which raises the numbers and notifies whoever is
 * listening to them. A read records which numbers it looked at, and re-runs when one of them moves: a read of named
 * entities only when those entities change, a read of the whole partition on any change.
 */


import { cacheKey, GROUP_SEP, cacheKeyOf } from '../args_key';
import { getOrCreate } from '../collections';
import { Dep, trackDependency } from './tracking';
import { ALL_ENTITIES, ChangeSet, isUnchanged } from '../table/change_set';
import type { Read } from '../read/surface';
import type { defineSqliteStore } from '../define_sqlite_store';

/**
 * Whether a partition key's parts name an actual partition: at least one part, and none of them empty. A key built from
 * args that are still missing a value has an empty part, and reads and fetches nothing.
 */
export const addressesPartition = (parts: readonly string[]): boolean => parts.length > 0 && parts.every(Boolean);

/** An empty, shared list of key parts, for a hook that must still run while its args name no partition yet. */
export const NO_PARTS: readonly string[] = Object.freeze([]);

/** A partition's key together with its key parts (the key's values as a list of strings). */
export interface PartitionEntry<Key> {
  /** The partition's key, as the store defines it. */
  key: Key;
  /** The key's values as a list of strings, which identify the partition in the version atom and in query keys. */
  parts: readonly string[];
}

/**
 * Pairs each partition key with its key parts, in the same order. Keys that name no partition (from args still missing
 * a value) are kept, so positions still line up with the list of keys.
 */
export function partitionEntries<Key>(keys: readonly Key[], toParts: (key: Key) => readonly string[]): PartitionEntry<Key>[] {
  return keys.map((key) => ({ key, parts: toParts(key) }));
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
export interface VersionAtom {
  /**
   * The partition's identity for dependency tracking: the store's name, and the partition's key parts joined into one
   * string.
   */
  key(parts: readonly string[]): [string, string];
  /**
   * The partition's version number: 0 before its first write, and one higher after every write that changes it.
   * Tracked: inside a tracking scope, the scope re-runs after any write that changes the partition.
   */
  get(parts: readonly string[]): number;
  /**
   * The version at which `entity` (an entity id, such as a `player_id`) last changed in the partition, or 0 if it
   * hasn't been written. Tracked for that entity only: inside a tracking scope, the scope re-runs only after a write
   * that changes that entity.
   */
  getEntity(parts: readonly string[], entityId: string): number;
  /**
   * A number that goes up only when the partition may have gone from empty to having rows, or back. Tracked for that
   * only: inside a tracking scope, the scope re-runs on such a change, not on every write.
   */
  getPresence(parts: readonly string[]): number;
  /**
   * Records a write to the partition and notifies the readers it concerns, returning the partition's new version.
   * `changes` is the entities the write changed (entity ids): readers of the whole partition and readers of those
   * entities are notified, and readers of other entities aren't. Omitted, or {@linkcode ALL_ENTITIES}, means every
   * entity changed. An empty set means nothing changed, and bumps nothing.
   */
  bump(parts: readonly string[], changes?: ChangeSet): number;
  /**
   * Bumps every partition the atom knows of (written, or listened to), with every entity changed, so every reader of
   * the store re-reads. Used when the store moves to a different database.
   */
  bumpAll(): void;
  /** Calls `listener` after every write that changes the partition, and returns a function that unsubscribes it. */
  subscribe(parts: readonly string[], listener: () => void): () => void;
}

type Listener = () => void;

interface VersionEntry {
  value: number;
  /** The version at which every entity last counted as changed: the first write, and every write of all entities. */
  epoch: number;
  presence: number;
  /** The entities that changed since the epoch, with the version each changed at. */
  changedAt: Map<string, number>;
  listeners: Set<Listener>;
  entityListeners: Map<string, Set<Listener>>;
  presenceListeners: Set<Listener>;
}

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
export function createVersionAtom(root: string): VersionAtom {
  const specifier = (parts: readonly string[]): string => cacheKeyOf(parts);
  const key = (parts: readonly string[]): [string, string] => [root, specifier(parts)];

  const entries = new Map<string, VersionEntry>();
  const ensure = (spec: string): VersionEntry =>
    getOrCreate(entries, spec, () => ({
      value: 0,
      epoch: 0,
      presence: 0,
      changedAt: new Map(),
      listeners: new Set(),
      entityListeners: new Map(),
      presenceListeners: new Set(),
    }));

  const valueOf = (spec: string): number => entries.get(spec)?.value ?? 0;
  const entityVersionOf = (spec: string, entityId: string): number => {
    const entry = entries.get(spec);
    if (!entry) return 0;
    return Math.max(entry.epoch, entry.changedAt.get(entityId) ?? 0);
  };
  const presenceOf = (spec: string): number => entries.get(spec)?.presence ?? 0;

  /**
   * Drops an entry nothing needs: never written, and nobody listening. A written entry must stay, since dropping it
   * resets its versions to 0, and a value cached at version 0 would then read as current.
   */
  const release = (spec: string, entry: VersionEntry): void => {
    if (entry.value !== 0 || entry.listeners.size || entry.entityListeners.size || entry.presenceListeners.size) return;
    if (entries.get(spec) !== entry) return;
    entries.delete(spec);
    // The descriptors follow the entry. One already handed to a sink keeps working, since it reads `entries` through
    // its spec on each call, and the next read rebuilds an identical one.
    partitionDeps.delete(spec);
    entityDeps.delete(spec);
    presenceDeps.delete(spec);
  };

  const listen = (spec: string, pick: (entry: VersionEntry) => Set<Listener>, listener: Listener): (() => void) => {
    const entry = ensure(spec);
    const set = pick(entry);
    set.add(listener);
    return () => {
      set.delete(listener);
      release(spec, entry);
    };
  };

  const subscribeEntity = (spec: string, entityId: string, listener: Listener): (() => void) => {
    const entry = ensure(spec);
    const set = getOrCreate(entry.entityListeners, entityId, () => new Set<Listener>());
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
  const partitionDeps = new Map<string, Dep>();
  const entityDeps = new Map<string, Map<string, Dep>>();
  const presenceDeps = new Map<string, Dep>();

  const partitionDep = (spec: string): Dep =>
    getOrCreate(partitionDeps, spec, () => ({
      id: cacheKey(root, spec),
      subscribe: (listener: Listener) => listen(spec, (entry) => entry.listeners, listener),
      getVersion: () => valueOf(spec),
    }));
  // An entity's id extends its partition's with a separator no part or entity carries, and presence doubles it, so none
  // of the three can collide with another.
  const entityDep = (spec: string, entityId: string): Dep =>
    getOrCreate(getOrCreate(entityDeps, spec, () => new Map<string, Dep>()), entityId, () => ({
      id: `${cacheKey(root, spec)}${GROUP_SEP}${entityId}`,
      subscribe: (listener: Listener) => subscribeEntity(spec, entityId, listener),
      getVersion: () => entityVersionOf(spec, entityId),
    }));
  const presenceDep = (spec: string): Dep =>
    getOrCreate(presenceDeps, spec, () => ({
      id: `${cacheKey(root, spec)}${GROUP_SEP}${GROUP_SEP}`,
      subscribe: (listener: Listener) => listen(spec, (entry) => entry.presenceListeners, listener),
      getVersion: () => presenceOf(spec),
    }));

  const get = (parts: readonly string[]): number => {
    const spec = specifier(parts);
    trackDependency(partitionDep(spec));
    return valueOf(spec);
  };

  const getEntity = (parts: readonly string[], entityId: string): number => {
    const spec = specifier(parts);
    trackDependency(entityDep(spec, entityId));
    return entityVersionOf(spec, entityId);
  };

  const getPresence = (parts: readonly string[]): number => {
    const spec = specifier(parts);
    trackDependency(presenceDep(spec));
    return presenceOf(spec);
  };

  /**
   * Raises the version and wakes exactly the listeners the write concerns: every partition listener, and the listeners
   * of the entities that changed — all of them when the write could not say which. A listener subscribed to several of
   * the changed entities is called once. Synchronous; ingest bumps inside `notifyManager.batch` so re-renders coalesce.
   */
  const bumpSpec = (spec: string, changes: ChangeSet): number => {
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

    const wake = new Set<Listener>(entry.listeners);
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
    wake.forEach((listener) => listener());
    return entry.value;
  };

  const bump = (parts: readonly string[], changes: ChangeSet = ALL_ENTITIES): number => bumpSpec(specifier(parts), changes);

  // Snapshotted first: a listener may write, and writing bumps, which mutates the map mid-walk.
  const bumpAll = (): void => Array.from(entries.keys()).forEach((spec) => bumpSpec(spec, ALL_ENTITIES));

  const subscribe = (parts: readonly string[], listener: Listener): (() => void) =>
    listen(specifier(parts), (entry) => entry.listeners, listener);

  const atom: VersionAtom = { key, get, getEntity, getPresence, bump, bumpAll, subscribe };
  entityLogs.set(atom, (parts) => {
    const entry = entries.get(specifier(parts));
    return { epoch: entry?.epoch ?? 0, changed: entry ? Array.from(entry.changedAt, ([id, version]) => ({ id, version })) : [] };
  });
  return atom;
}

/** What each atom remembers of a partition's entity changes, read without tracking, for the inspector. */
const entityLogs = new WeakMap<VersionAtom, (parts: readonly string[]) => EntityChanges>();

/** The entities that changed in a partition since every entity last counted as changed. */
export interface EntityChanges {
  /** The version at which every entity last counted as changed: the partition's first write, or a write of all. */
  epoch: number;
  /** Each entity that changed after the epoch, with the version it changed at. */
  changed: Array<{ id: string; version: number }>;
}

/** The partition's entity changes as `atom` remembers them; empty for an atom {@linkcode createVersionAtom} didn't make. */
export function entityChangesOf(atom: VersionAtom, parts: readonly string[]): EntityChanges {
  return entityLogs.get(atom)?.(parts) ?? { epoch: 0, changed: [] };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { ALL_ENTITIES, Read, defineSqliteStore, trackDependency };
