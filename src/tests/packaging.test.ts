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

import { configureCellar } from '../runtime';

const ROOT = join(__dirname, '..', '..');
const SUBPATHS = ['nitro', 'sqljs', 'testing', 'diagnostics', 'inspector', 'redux'];
/**
 * Subpaths that are CommonJS whatever the importer asks for: the Node entry starts its writer from a file beside it,
 * which only CommonJS can locate. The state it shares with the core lives in a global slot rather than a module.
 */
const COMMONJS_ONLY = ['node'];

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

    expect(declared).toEqual([...SUBPATHS, ...COMMONJS_ONLY].sort());
  });

  it('sends a CommonJS-only subpath into the CommonJS build however it is imported, stub and exports alike', () => {
    const exports = readPackage().exports as unknown as Record<string, Record<string, Record<string, string>>>;
    for (const subpath of COMMONJS_ONLY) {
      const entry = exports[`./${subpath}`];
      const builds = [entry.import.default, entry.import.types, entry.require.default, entry.require.types, readPackage(subpath).main, readPackage(subpath).types];

      expect(builds.map(buildOf)).toEqual(builds.map(() => 'commonjs'));
    }
  });

  it('keeps the runtime a CommonJS-only subpath reads in one global slot, so both builds see one configuration', () => {
    configureCellar({ serverRendering: true });
    const slot = (globalThis as unknown as Record<symbol, { runtime: { serverRendering: boolean } } | undefined>)[Symbol.for('cellar.runtime')];

    expect(slot?.runtime.serverRendering).toBe(true);
    configureCellar({ serverRendering: false });
  });
});
