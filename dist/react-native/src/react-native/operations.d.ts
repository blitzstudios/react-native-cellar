/** What the app answers the panel and agents with, over Cellar's inspector. */
import * as cellarInspector from '@sleeperhq/react-native-cellar/inspector';
import type { InspectedStore, InspectorEvent } from '@sleeperhq/react-native-cellar/inspector';
import type { IngestReport, PartitionRef, QueryRequest, StoreOverview } from '../shared/protocol';
/** The part of Cellar's inspector the plugin reads; a test hands in its own. */
export type CellarInspector = Pick<typeof cellarInspector, 'inspectedStores' | 'inspectedStore' | 'inspectedCaches' | 'recentInspectorEvents' | 'onInspectorEvent' | 'getIngestTimings' | 'rollupIngestTimings'>;
export declare const defaultInspector: CellarInspector;
/** The store named `name`, or an error that lists the stores there are. */
export declare function storeOf(inspector: CellarInspector, name: string): InspectedStore;
export declare function listStores(inspector: CellarInspector): Promise<StoreOverview[]>;
export declare function runQuery(inspector: CellarInspector, { store, sql, params, limit, offset }: QueryRequest): Promise<cellarInspector.InspectedQueryResult>;
export declare function listCaches(inspector: CellarInspector, store?: string): cellarInspector.InspectedCache[];
export declare function refetchPartition(inspector: CellarInspector, { store, key }: PartitionRef): boolean;
export declare function clearPartitionEtag(inspector: CellarInspector, { store, key }: PartitionRef): void;
export declare function ingestReport(inspector: CellarInspector): IngestReport;
/** The recorded events of `kinds` for `store`, newest last, at most `limit` of them. */
export declare function filterEvents(events: readonly InspectorEvent[], { store, kinds, limit }: {
    store?: string;
    kinds?: readonly InspectorEvent['kind'][];
    limit?: number;
}): InspectorEvent[];
