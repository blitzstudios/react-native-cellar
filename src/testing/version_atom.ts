/** A real {@linkcode VersionAtom} that also records its bumps, for tests. */

import { createVersionAtom, VersionAtom } from '../reactivity/version_atom';
import { ALL_ENTITIES, ChangeSet, isUnchanged } from '../table/change_set';

/** Creates a {@linkcode VersionAtom} that records each bump that changed something. */
export function createTestVersionAtom(root = 'test_version'): VersionAtom & {
  /** Each bumped partition's key parts joined with `:`, in order. */
  bumped: string[];
  /** The entities each bump changed, in the same order. */
  bumpedWith: ChangeSet[];
} {
  const atom = createVersionAtom(root);
  const realBump = atom.bump;
  const bumped: string[] = [];
  const bumpedWith: ChangeSet[] = [];
  const bump: VersionAtom['bump'] = (parts, changes = ALL_ENTITIES) => {
    if (!isUnchanged(changes)) {
      bumped.push(parts.join(':'));
      bumpedWith.push(changes);
    }
    return realBump(parts, changes);
  };
  return Object.assign(atom, { bump, bumped, bumpedWith });
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { VersionAtom };
