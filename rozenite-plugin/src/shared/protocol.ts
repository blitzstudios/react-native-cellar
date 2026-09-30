/**
 * What the app and the panel say to each other. The panel calls the app's methods over Rozenite's RPC; the app pushes
 * what the stores do, in batches, as `cellar:events`.
 */

import type {
  InspectedCache,
  InspectedCacheEntries,
  InspectedEntity,
  InspectedEntityChanges,
  IngestRollup,
  IngestTiming,
  InspectedPartition,
  InspectedQueryResult,
  InspectedSchema,
  InspectedSummary,
  InspectorEvent,
} from '@sleeperhq/react-native-cellar/inspector';

export const PLUGIN_ID = '@sleeperhq/rozenite-plugin-cellar';

/** A value a query binds to a `?`. */
export type SqlParam = string | number | null;

/** A store in the store list: its name, its table as declared, and its totals. */
export interface StoreOverview {
  name: string;
  schema: InspectedSchema;
  summary: InspectedSummary;
}

/** A store's name and one of its partitions, for the actions on a partition. */
export interface PartitionRef {
  store: string;
  key: string;
}

/** A query from the panel's editor, or from an agent. */
export interface QueryRequest {
  store: string;
  sql: string;
  params?: SqlParam[];
  limit?: number;
  offset?: number;
}

/** A copy of every store's database in one SQLite file on the device: see Cellar's `dumpSqliteStores`. */
export interface DatabaseDump {
  name: string;
  /** The file's path on the device; on a simulator, a path on the Mac. */
  path: string;
  bytes: number;
  tables: Array<{ database: string; table: string; rows: number }>;
}

/** The recent fetches, and their totals per store. */
export interface IngestReport {
  timings: IngestTiming[];
  rollup: IngestRollup[];
}

/** The methods the app answers. */
export type CellarMethods = {
  /** Every declared store, with its schema and totals. */
  stores: () => Promise<StoreOverview[]>;
  /** One store's partitions. */
  partitions: (params: { store: string }) => Promise<InspectedPartition[]>;
  /** One entity: an id within one partition. */
  entity: (params: PartitionRef & { id: string }) => Promise<InspectedEntity>;
  /** A partition's recently changed entities. */
  entityChanges: (params: PartitionRef & { limit?: number }) => Promise<InspectedEntityChanges>;
  /** A store's caches, or every store's, with what each has done. */
  caches: (params: { store?: string; heap?: boolean }) => Promise<InspectedCache[]>;
  /** A page of one cache's entries, most recently used first. */
  cacheEntries: (params: { store: string; cache: string; offset?: number; limit?: number }) => Promise<InspectedCacheEntries>;
  /** One read-only statement over a store's database. */
  query: (params: QueryRequest) => Promise<InspectedQueryResult>;
  /** Fetches a partition again; false for a store that doesn't fetch. */
  refetch: (params: PartitionRef) => Promise<boolean>;
  /** Deletes a partition's ETag, so its next fetch brings the whole body. */
  clearEtag: (params: PartitionRef) => Promise<void>;
  /** The events the app has recorded, after `afterId` when it is given. */
  events: (params: { afterId?: number }) => Promise<InspectorEvent[]>;
  /** The recent fetch timings, and their totals per store. */
  ingest: () => Promise<IngestReport>;
  /** Copies every store's database into one SQLite file on the device. */
  dump: () => Promise<DatabaseDump>;
  /** The file name the app dumps to, which the panel suggests when saving. */
  dumpName: () => Promise<string>;
  /** Part of the latest dump's file, for the panel to save: at most {@linkcode DUMP_CHUNK_BYTES} from `offset`. */
  readDump: (params: { path: string; offset: number }) => Promise<DumpChunk>;
};

/** The most bytes of a dump one `readDump` answers. */
export const DUMP_CHUNK_BYTES = 1024 * 1024;

/** Bytes of a dump's file, as base64, and the file's whole size. */
export interface DumpChunk {
  base64: string;
  size: number;
}

/** What the app sends without being asked. */
export type CellarEventMap = {
  /** Events as they are recorded, batched, as the JSON text of an `InspectorEvent[]`: see `wire.ts`. */
  'cellar:events': { json: string };
};

export type { InspectedCache, InspectedCacheEntries, InspectedEntity, InspectedEntityChanges, IngestRollup, IngestTiming, InspectedPartition, InspectedQueryResult, InspectedSchema, InspectedSummary, InspectorEvent };
