"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createTestVersionAtom = createTestVersionAtom;
var _version_atom = require("../reactivity/version_atom.js");
var _change_set = require("../table/change_set.js");
/** A real {@linkcode VersionAtom} that also records its bumps, for tests. */

/** Creates a {@linkcode VersionAtom} that records each bump that changed something. */
function createTestVersionAtom(root = 'test_version') {
  const atom = (0, _version_atom.createVersionAtom)(root);
  const realBump = atom.bump;
  const bumped = [];
  const bumpedWith = [];
  const bump = (parts, changes = _change_set.ALL_ENTITIES) => {
    if (!(0, _change_set.isUnchanged)(changes)) {
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