"use strict";

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
export const ALL_ENTITIES = 'all';

/**
 * What a write changed: the entity id (such as a `player_id`) of each row it added, changed or removed, or
 * {@linkcode ALL_ENTITIES} when every entity counts as changed. An empty set means the write changed nothing.
 */

/** What a row table write returns: its change set, and how many rows it was given. */

/** The change set of a write that changed nothing: an empty set, frozen so it can be shared. */
export const NO_CHANGES = Object.freeze(new Set());

/** Whether a change set is empty (the write changed nothing), in which case bumping with it does nothing. */
export function isUnchanged(changes) {
  return changes !== ALL_ENTITIES && changes.size === 0;
}

/**
 * Combines the change sets of two writes into one (every entity either changed), such as the chunks of one push. If
 * either is {@linkcode ALL_ENTITIES}, so is the result.
 */
export function unionChanges(left, right) {
  if (left === ALL_ENTITIES || right === ALL_ENTITIES) return ALL_ENTITIES;
  if (!right.size) return left;
  if (!left.size) return right;
  const out = new Set(left);
  for (const entityId of right) out.add(entityId);
  return out;
}

/** Whether a write touched any of `entities`. Walks the smaller side, since a change set is usually a handful. */
export function touchesAny(changes, entityIds) {
  if (changes === ALL_ENTITIES) return true;
  const [small, large] = changes.size <= entityIds.size ? [changes, entityIds] : [entityIds, changes];
  for (const entityId of small) if (large.has(entityId)) return true;
  return false;
}
//# sourceMappingURL=change_set.js.map