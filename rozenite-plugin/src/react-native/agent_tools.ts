/** Registers the Cellar agent tools with Rozenite while the calling component is mounted. */

import { useRozenitePluginAgentTool } from '@rozenite/agent-bridge';
import type { InspectorEvent } from '@sleeperhq/react-native-cellar/inspector';
import { useMemo } from 'react';
import { PLUGIN_ID } from '../shared/protocol';
import type { PartitionRef, QueryRequest } from '../shared/protocol';
import { agentToolHandlers, cellarAgentTools } from './agent_tool_contracts';
import { defaultInspector } from './operations';
import type { CellarInspector } from './operations';

/** Registers every Cellar agent tool while the calling component is mounted. */
export function useCellarAgentTools(inspector: CellarInspector = defaultInspector): void {
  const handlers = useMemo(() => agentToolHandlers(inspector), [inspector]);
  useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.listStores, handler: handlers.listStores });
  useRozenitePluginAgentTool<{ store: string }>({ pluginId: PLUGIN_ID, tool: cellarAgentTools.describeStore, handler: handlers.describeStore });
  useRozenitePluginAgentTool<{ store: string; match?: string; limit?: number }>({
    pluginId: PLUGIN_ID,
    tool: cellarAgentTools.listPartitions,
    handler: handlers.listPartitions,
  });
  useRozenitePluginAgentTool<QueryRequest>({ pluginId: PLUGIN_ID, tool: cellarAgentTools.query, handler: handlers.query });
  useRozenitePluginAgentTool<PartitionRef & { limit?: number }>({ pluginId: PLUGIN_ID, tool: cellarAgentTools.entityChanges, handler: handlers.entityChanges });
  useRozenitePluginAgentTool<{ store?: string; heap?: boolean }>({ pluginId: PLUGIN_ID, tool: cellarAgentTools.listCaches, handler: handlers.listCaches });
  useRozenitePluginAgentTool<{ store: string; cache: string; offset?: number; limit?: number }>({
    pluginId: PLUGIN_ID,
    tool: cellarAgentTools.cacheEntries,
    handler: handlers.cacheEntries,
  });
  useRozenitePluginAgentTool<{ store?: string; kinds?: InspectorEvent['kind'][]; limit?: number }>({
    pluginId: PLUGIN_ID,
    tool: cellarAgentTools.recentEvents,
    handler: handlers.recentEvents,
  });
  useRozenitePluginAgentTool<{ store?: string }>({ pluginId: PLUGIN_ID, tool: cellarAgentTools.ingestTimings, handler: handlers.ingestTimings });
  useRozenitePluginAgentTool<PartitionRef>({ pluginId: PLUGIN_ID, tool: cellarAgentTools.refetchPartition, handler: handlers.refetchPartition });
  useRozenitePluginAgentTool<PartitionRef>({ pluginId: PLUGIN_ID, tool: cellarAgentTools.clearEtag, handler: handlers.clearEtag });
}
