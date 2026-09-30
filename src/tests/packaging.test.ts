/**
 * Pins that every entry point resolves into the same build, because a consumer that reaches two of them is otherwise
 * running two copies of this package.
 *
 * The subpaths are published twice over: in the root `exports` map, and again as a directory holding a `package.json`
 * stub. The stub exists for resolvers that do not read `exports` — Metro with `unstable_enablePackageExports` off is
 * the one that matters — and such a resolver picks `main`, since `module` is not in its main-field list. So if the
 * root's `main` names one build and a stub's names the other, an app importing both the root and a subpath loads both
 * builds, and every module-level value in this package exists twice. That is not a build-size problem; it silently
 * splits state. It shipped that way once: the ingest timing ring was written by the root's copy and read by the
 * subpath's, so the diagnostics dump reported no ingests at all while ingests were being recorded the whole time.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SUBPATHS = ['nitro', 'sqljs', 'testing', 'diagnostics', 'inspector', 'redux'];

function readPackage(...segments: string[]): Record<string, string> {
  return JSON.parse(readFileSync(join(ROOT, ...segments, 'package.json'), 'utf8'));
}

/** The build a path names — `lib/module/...` and `../lib/commonjs/...` are the two we can land in. */
function buildOf(mainField: string): string {
  const match = /lib\/(?:typescript\/)?(module|commonjs)\//.exec(mainField);
  if (!match) throw new Error(`this main field names no build under lib/: ${mainField}`);
  return match[1];
}

describe('entry point resolution', () => {
  it('sends the root and every subpath stub into one build, so a consumer loads one copy', () => {
    const root = buildOf(readPackage().main);
    const stubs = Object.fromEntries(SUBPATHS.map((subpath) => [subpath, buildOf(readPackage(subpath).main)]));

    expect(stubs).toEqual(Object.fromEntries(SUBPATHS.map((subpath) => [subpath, root])));
  });

  it('types the root and every subpath stub from one build too, so a type from one entry is the same type in another', () => {
    // A resolver reading the stub takes its `types`. Were a stub's declarations from the other build, a schema typed
    // through the root and handed to a subpath's generic would meet a second, unrelated declaration of the same type,
    // and the generic would infer its bare constraint instead of the schema's row.
    const root = buildOf(readPackage().types);
    const stubs = Object.fromEntries(SUBPATHS.map((subpath) => [subpath, buildOf(readPackage(subpath).types)]));

    expect(stubs).toEqual(Object.fromEntries(SUBPATHS.map((subpath) => [subpath, root])));
  });

  it('declares a stub for every subpath in the exports map, so no subpath is reachable only one way', () => {
    const exports = readPackage().exports as unknown as Record<string, unknown>;
    const declared = Object.keys(exports)
      .filter((key) => key !== '.' && key !== './package.json')
      .map((key) => key.replace(/^\.\//, ''))
      .sort();

    expect(declared).toEqual([...SUBPATHS].sort());
  });
});
