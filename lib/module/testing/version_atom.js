"use strict";

/** A real {@linkcode VersionAtom} that also records its bumps, for tests. */

import { createVersionAtom } from "../reactivity/version_atom.js";
import { ALL_ENTITIES, isUnchanged } from "../table/change_set.js";

/** Creates a {@linkcode VersionAtom} that records each bump that changed something. */
export function createTestVersionAtom(root = 'test_version') {
  const atom = createVersionAtom(root);
  const realBump = atom.bump;
  const bumped = [];
  const bumpedWith = [];
  const bump = (parts, changes = ALL_ENTITIES) => {
    if (!isUnchanged(changes)) {
      bumped.push(parts.join(':'));
      bumpedWith.push(changes);
    }
    return realBump(parts, changes);
  };
  return Object.assign(atom, {
    bump,
    bumped,
    bumpedWith
  });
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=version_atom.js.map