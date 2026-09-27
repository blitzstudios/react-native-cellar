/**
 * Pins that a consumer can emit declaration files for what it builds with this package. A consumer that exports a
 * store, a column list or a read without annotating it gets that value's inferred type written into its `.d.ts`, and
 * TypeScript can only write a type it can name through the package's entry point. A type that appears inside an
 * inferred type but isn't exported from the entry point fails the consumer's build with TS4023, even though
 * `tsc --noEmit` and every bundler pass.
 *
 * The consumer here sees the package as the app does: Cellar's declarations are emitted to a temporary
 * `node_modules/@sleeperhq/react-native-cellar`, and the consumer imports it by package name, so no relative path can
 * reach a type the entry point doesn't export.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';

const ROOT = join(__dirname, '..', '..');

/** Exports a value built with every factory a store is written with, each left to inference. */
const CONSUMER = `
import {
  byEntity,
  byPartition,
  createTrackedSelector,
  createWindowedList,
  defineShredColumns,
  defineSqliteStore,
  pairRead,
  type Loose,
  type RowOf,
  type ShredColumn,
  type StoreTableSchema,
} from '@sleeperhq/react-native-cellar';

type Item = { id: string; team?: string; points?: number };
type Ctx = { league: string };

const COLUMNS = [
  { name: 'id', type: 'TEXT', notNull: true, js: (item: Item): string => item.id, op: { op: 'coalesceText', paths: ['id'], emptyDefault: true } },
  { name: 'league', type: 'TEXT', notNull: true, js: (_item: Item, ctx: Ctx): string => ctx.league, op: { op: 'bind', index: 1 } },
  { name: 'team', type: 'TEXT', js: (item: Item): string | null => item.team ?? null, op: { op: 'text', path: 'team' } },
  { name: 'points', type: 'REAL', js: (item: Item): number | null => item.points ?? null, op: { op: 'real', path: 'points' } },
] as const satisfies readonly ShredColumn<Item, Ctx>[];

const JS_ONLY_COLUMNS = [
  { name: 'id', type: 'TEXT', notNull: true, js: (item: Item): string => item.id },
] as const satisfies readonly ShredColumn<Item, void>[];

export const itemShred = defineShredColumns<Item, Ctx>()(COLUMNS);
export const jsOnlyShred = defineShredColumns<Item>()(JS_ONLY_COLUMNS);

type ItemRow = RowOf<typeof COLUMNS>;

const schema: StoreTableSchema<ItemRow> = {
  table: 'items',
  columns: itemShred.columnDefs,
  primaryKey: ['id'],
  entityId: 'id',
};

type LeagueKey = { league: string };
type ItemKey = LeagueKey & { id: string };
type ItemsKey = { leagues: readonly string[]; id: string };

export const itemStore = defineSqliteStore({
  name: 'item',
  schema,
  partition: { fields: ['league'], toPartition: (args: Loose<LeagueKey>) => (args.league ? { league: args.league } : null) },
  build: (cellar) => {
    const { card, byTeam } = cellar.defineCaches({
      card: byEntity({ max: 64, fromRows: ([row]) => ({ id: row.id }) }),
      byTeam: byPartition<Map<string, ItemRow[]>>({ max: 4 }),
    });
    const push = cellar.createPushIngest({
      idOf: (item: Item) => item.id,
      toRows: (key, batch) => batch.map((item) => ({ ...itemShred.row(item, { league: key }), partition_key: key })),
      onWrite: cellar.clearEtag,
    });
    return {
      reads: {
        Item: cellar.defineRead<ItemKey, { id: string } | undefined>({
          select: (args, key) => card.at(key, args.id),
          empty: undefined,
        }),
        Rows: cellar.defineRead<LeagueKey, ItemRow[]>({
          select: (_args, key) => cellar.rows(key).map((row) => row, []),
          empty: [],
        }),
        Memoized: cellar.defineRead<LeagueKey, number>({
          select: (_args, key) => byTeam.for(key).read(() => new Map()).size,
          empty: 0,
        }),
        Across: cellar.defineReadAcross<ItemsKey, number>({
          partitions: (args) => args.leagues.map((league) => ({ league })),
          select: (_args, keys) => keys.length,
          empty: 0,
        }),
      },
      push: { queue: push.queue },
    };
  },
});

export const itemReads = {
  Item: pairRead(() => itemStore.reads.Item),
};

export const itemList = createWindowedList<LeagueKey, ItemRow, { id: string }>({
  useList: () => ({ data: [], status: 'success', isLoading: false, isFetching: false, isSuccess: true, isError: false, refetch: () => {} }),
  idOf: (row) => row.id,
  prehydrated: () => undefined,
  useDetailByIds: () => undefined,
});

export const selectCount = createTrackedSelector([(state: { n: number }) => state.n], (n) => n + 1);
`;

/** Emits `program`'s declarations into memory, returning its diagnostics as `file(line): message` strings. */
function declarationErrors(rootNames: string[], options: ts.CompilerOptions, outDir?: string): string[] {
  const program = ts.createProgram(rootNames, { ...options, declaration: true, emitDeclarationOnly: true, outDir });
  const result = program.emit(undefined, outDir ? undefined : () => {});
  return [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (!diagnostic.file || diagnostic.start === undefined) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}(${line + 1}): ${message}`;
  });
}

describe('declaration emit', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cellar-dts-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets a consumer emit declarations for every store, column list and read it exports', () => {
    const config = ts.getParsedCommandLineOfConfigFile(join(ROOT, 'tsconfig.build.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    if (!config) throw new Error('tsconfig.build.json did not parse');

    const packageDir = join(dir, 'node_modules', '@sleeperhq', 'react-native-cellar');
    mkdirSync(packageDir, { recursive: true });
    const kernelErrors = declarationErrors(config.fileNames, { ...config.options, rootDir: join(ROOT, 'src'), declarationMap: false }, packageDir);
    expect(kernelErrors).toEqual([]);
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleeperhq/react-native-cellar', types: 'index.d.ts' }));

    const consumer = join(dir, 'consumer.ts');
    writeFileSync(consumer, CONSUMER);
    const errors = declarationErrors([consumer], {
      strict: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      jsx: ts.JsxEmit.ReactJSX,
      skipLibCheck: true,
      types: [],
    });

    expect(errors).toEqual([]);
  });
});
