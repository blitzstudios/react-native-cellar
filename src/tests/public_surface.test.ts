/**
 * Pins what each entry point exports. A barrel is the one file where an addition costs nothing at the keyboard and
 * everything later: a name a consumer can reach is a name this package has to keep working, so growing one of these
 * lists should be a line in a diff someone chose to write.
 *
 * The lists are read out of the source rather than off the module, because half the surface is types, which no longer
 * exist by the time a test could import them.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

function exportedFrom(entry: string): string[] {
  const source = readFileSync(join(__dirname, '..', entry), 'utf8');
  const names: string[] = [];
  const clause = /export\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
  let match = clause.exec(source);
  while (match) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '');
      if (name) names.push(name);
    }
    match = clause.exec(source);
  }
  return names.sort();
}

describe('the core entry point', () => {
  it('exports what a store, a service or a screen writes against, and nothing else', () => {
    expect(exportedFrom('index.ts')).toEqual([
      'ALL_ENTITIES', 'BoundedLru', 'CacheDeclaration', 'CacheFactory', 'CacheKeyPart', 'CellarContext', 'ChangeSet',
      'ColumnDef', 'Coverage', 'CoverageProviderProps', 'DATA_RESULT_KEYS', 'DataResult', 'DataStatus', 'Dep',
      'DerivedValues', 'DerivedValuesDef', 'EachOf', 'EntityCacheDeclaration', 'Loose', 'MaybeId', 'NO_CHANGES',
      'NativeShredColumns', 'NativeShredSpec', 'PairedRead', 'PairedReadAcross', 'PartitionKeyColumn',
      'PartitionLifecycle', 'PartitionSpec', 'PinnedConnection', 'PrimeState', 'QueryClient',
      'QueryRuntime', 'QuerySpec', 'QueryStatus', 'RAW_TEXT_RESPONSE_TRANSFORM', 'RawQuery', 'ReadAcross', 'ReadGate',
      'ReadGateRuntime', 'ReadOptions', 'RowOf', 'RowTable', 'RowTableSchema', 'ShredColumn', 'ShredColumns',
      'ShredColumnsBase', 'ShredOp', 'ShredSpec', 'SqlValue', 'SqliteConnection', 'SqliteStore', 'StoreFetchSpec',
      'StoreFunctions', 'StorePush', 'StorePushOf', 'StorePushSpec', 'StoreSurface', 'StoreTableSchema',
      'TrackedValueOptions', 'VersionAtom', 'WindowedBlock', 'WithReadSpec', 'WriteResult',
      'byEntity', 'byPartition', 'configureCellar', 'createBoundedLru', 'createCoverage', 'createOnceGuard',
      'createSqliteRowTable', 'createTrackedSelector', 'createWindowedList', 'defineShredColumns', 'defineSqliteStore',
      'makeResult', 'pairRead', 'pinnedReader', 'reactQueryRuntime', 'readRows',
      'readRowsIn', 'reportStoreDegradation', 'rowsOf', 'runTracked', 'shallowEqualArray',
      'shallowEqualRecord', 'shallowEqualStruct', 'shallowEqualValue', 'useTrackedValue', 'withRead',
    ]);
  });

  it('keeps every name it exports reachable, so nothing here is a stale re-export', () => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires -- the whole module, by name
    const core = require('../index') as Record<string, unknown>;
    const values = exportedFrom('index.ts').filter((name) => name in core);

    expect(values.length).toBeGreaterThan(0);
    for (const name of values) expect(core[name]).toBeDefined();
  });
});

describe('the nitro entry point', () => {
  it('exports only the on-device wiring', () => {
    expect(exportedFrom('nitro/index.ts')).toEqual(['BindSqliteStoreOptions', 'bindSqliteStore', 'getOpenSqliteConnections', 'openNitroConnection', 'retrySqliteStores']);
  });
});

describe('the sqljs entry point', () => {
  it('exports only the web wiring', () => {
    expect(exportedFrom('sqljs/index.ts')).toEqual(['SqlJsModule', 'bindSqlJsStore', 'openSqlJsConnection']);
  });
});

describe('the diagnostics entry point', () => {
  it('exports what a developer surface dumps, which no shipping screen reads', () => {
    expect(exportedFrom('diagnostics/index.ts')).toEqual([
      'IngestRollup', 'IngestTiming', 'LogLevel', 'getIngestTimings', 'getLogLevel', 'rollupIngestTimings', 'setLogLevel',
    ]);
  });
});

describe('the testing entry point', () => {
  it('exports the fixtures a store suite needs, including the internals no shipping code calls', () => {
    expect(exportedFrom('testing/index.ts')).toEqual([
      'SqlJsCapabilities', 'SqlJsConnection', 'createSqlJsConnection', 'createStoreTable', 'createTestRowTable',
      'createTestRowTableWithConnection', 'createTestStoreTable', 'createTestStoreTableWithConnection',
      'createTestVersionAtom', 'createVersionAtom', 'evalShredElement', 'initSqlJs', 'installTestRuntime', 'itDev', 'resetOnceGuards', 'storeShredProgram', 'testCache',
    ]);
  });
});
