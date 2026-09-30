/**
 * The tools an agent (Cursor, Claude, the Rozenite CLI) calls to look into the stores, and what each answers: the same
 * operations the panel's calls use. `useCellarAgentTools` registers them under the plugin's id.
 */
import type { InspectorEvent } from '@sleeperhq/react-native-cellar/inspector';
import type { PartitionRef, QueryRequest } from '../shared/protocol';
import type { CellarInspector } from './operations';
export declare const cellarAgentTools: {
    listStores: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {};
        };
        readOnly: true;
        idempotent: true;
    };
    describeStore: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                store: {
                    readonly type: "string";
                    readonly description: "The store name, from list-stores, such as \"player_stats_store\".";
                };
            };
            required: string[];
        };
        readOnly: true;
        idempotent: true;
    };
    listPartitions: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                store: {
                    readonly type: "string";
                    readonly description: "The store name, from list-stores, such as \"player_stats_store\".";
                };
                match: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        readOnly: true;
        idempotent: true;
    };
    query: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                store: {
                    readonly type: "string";
                    readonly description: "The store name, from list-stores, such as \"player_stats_store\".";
                };
                sql: {
                    type: string;
                    description: string;
                };
                params: {
                    type: string;
                    items: {
                        type: string[];
                    };
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        readOnly: true;
        idempotent: true;
    };
    recentEvents: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                store: {
                    type: string;
                    description: string;
                };
                kinds: {
                    type: string;
                    items: {
                        type: string;
                        enum: ("write" | "binding" | "fetch" | "degradation")[];
                    };
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
        };
        readOnly: true;
    };
    ingestTimings: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                store: {
                    type: string;
                    description: string;
                };
            };
        };
        readOnly: true;
    };
    refetchPartition: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                store: {
                    readonly type: "string";
                    readonly description: "The store name, from list-stores, such as \"player_stats_store\".";
                };
                key: {
                    readonly type: "string";
                    readonly description: "The partition key, from list-partitions.";
                };
            };
            required: string[];
        };
        idempotent: true;
    };
    clearEtag: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                store: {
                    readonly type: "string";
                    readonly description: "The store name, from list-stores, such as \"player_stats_store\".";
                };
                key: {
                    readonly type: "string";
                    readonly description: "The partition key, from list-partitions.";
                };
            };
            required: string[];
        };
        idempotent: true;
    };
};
export declare const agentToolHandlers: (inspector: CellarInspector) => {
    listStores: () => Promise<{
        stores: {
            binding: import("@sleeperhq/react-native-cellar/inspector").InspectedBinding;
            rows: number;
            partitions: number;
            databaseBytes?: number;
            name: string;
            table: string;
        }[];
    }>;
    describeStore: ({ store }: {
        store: string;
    }) => Promise<{
        binding: import("@sleeperhq/react-native-cellar/inspector").InspectedBinding;
        table: string;
        metaTable: string;
        columns: import("@sleeperhq/react-native-cellar/inspector").InspectedColumn[];
        primaryKey: string[];
        entityColumn: string;
        indexes: Array<{
            name: string;
            columns: string[];
        }>;
        reads: string[];
        nativeShred: boolean;
        name: string;
    }>;
    listPartitions: ({ store, match, limit }: {
        store: string;
        match?: string;
        limit?: number;
    }) => Promise<{
        total: number;
        partitions: import("@sleeperhq/react-native-cellar/inspector").InspectedPartition[];
    }>;
    query: (request: QueryRequest) => Promise<import("@sleeperhq/react-native-cellar/inspector").InspectedQueryResult>;
    recentEvents: ({ store, kinds, limit }: {
        store?: string;
        kinds?: InspectorEvent["kind"][];
        limit?: number;
    }) => Promise<{
        events: InspectorEvent[];
    }>;
    ingestTimings: ({ store }: {
        store?: string;
    }) => Promise<import("../shared/protocol").IngestReport>;
    refetchPartition: (ref: PartitionRef) => Promise<{
        refetched: boolean;
    }>;
    clearEtag: (ref: PartitionRef) => Promise<{
        cleared: boolean;
    }>;
};
