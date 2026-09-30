/** Registers the Cellar agent tools with Rozenite while the calling component is mounted. */
import { useRozenitePluginAgentTool } from '@rozenite/agent-bridge';
import { useMemo } from 'react';
import { PLUGIN_ID } from '../shared/protocol';
import { agentToolHandlers, cellarAgentTools } from './agent_tool_contracts';
import { defaultInspector } from './operations';
/** Registers every Cellar agent tool while the calling component is mounted. */
export function useCellarAgentTools(inspector = defaultInspector, dump) {
    const handlers = useMemo(() => agentToolHandlers(inspector, dump), [inspector, dump]);
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.dumpDatabases, handler: handlers.dumpDatabases });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.listStores, handler: handlers.listStores });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.describeStore, handler: handlers.describeStore });
    useRozenitePluginAgentTool({
        pluginId: PLUGIN_ID,
        tool: cellarAgentTools.listPartitions,
        handler: handlers.listPartitions,
    });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.query, handler: handlers.query });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.entity, handler: handlers.entity });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.entityChanges, handler: handlers.entityChanges });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.listCaches, handler: handlers.listCaches });
    useRozenitePluginAgentTool({
        pluginId: PLUGIN_ID,
        tool: cellarAgentTools.cacheEntries,
        handler: handlers.cacheEntries,
    });
    useRozenitePluginAgentTool({
        pluginId: PLUGIN_ID,
        tool: cellarAgentTools.recentEvents,
        handler: handlers.recentEvents,
    });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.ingestTimings, handler: handlers.ingestTimings });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.refetchPartition, handler: handlers.refetchPartition });
    useRozenitePluginAgentTool({ pluginId: PLUGIN_ID, tool: cellarAgentTools.clearEtag, handler: handlers.clearEtag });
}
