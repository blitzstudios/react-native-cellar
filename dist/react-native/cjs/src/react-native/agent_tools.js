"use strict";
/** Registers the Cellar agent tools with Rozenite while the calling component is mounted. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.useCellarAgentTools = useCellarAgentTools;
const agent_bridge_1 = require("@rozenite/agent-bridge");
const react_1 = require("react");
const protocol_1 = require("../shared/protocol");
const agent_tool_contracts_1 = require("./agent_tool_contracts");
const operations_1 = require("./operations");
/** Registers every Cellar agent tool while the calling component is mounted. */
function useCellarAgentTools(inspector = operations_1.defaultInspector) {
    const handlers = (0, react_1.useMemo)(() => (0, agent_tool_contracts_1.agentToolHandlers)(inspector), [inspector]);
    (0, agent_bridge_1.useRozenitePluginAgentTool)({ pluginId: protocol_1.PLUGIN_ID, tool: agent_tool_contracts_1.cellarAgentTools.listStores, handler: handlers.listStores });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({ pluginId: protocol_1.PLUGIN_ID, tool: agent_tool_contracts_1.cellarAgentTools.describeStore, handler: handlers.describeStore });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({
        pluginId: protocol_1.PLUGIN_ID,
        tool: agent_tool_contracts_1.cellarAgentTools.listPartitions,
        handler: handlers.listPartitions,
    });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({ pluginId: protocol_1.PLUGIN_ID, tool: agent_tool_contracts_1.cellarAgentTools.query, handler: handlers.query });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({ pluginId: protocol_1.PLUGIN_ID, tool: agent_tool_contracts_1.cellarAgentTools.entityChanges, handler: handlers.entityChanges });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({ pluginId: protocol_1.PLUGIN_ID, tool: agent_tool_contracts_1.cellarAgentTools.listCaches, handler: handlers.listCaches });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({
        pluginId: protocol_1.PLUGIN_ID,
        tool: agent_tool_contracts_1.cellarAgentTools.cacheEntries,
        handler: handlers.cacheEntries,
    });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({
        pluginId: protocol_1.PLUGIN_ID,
        tool: agent_tool_contracts_1.cellarAgentTools.recentEvents,
        handler: handlers.recentEvents,
    });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({ pluginId: protocol_1.PLUGIN_ID, tool: agent_tool_contracts_1.cellarAgentTools.ingestTimings, handler: handlers.ingestTimings });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({ pluginId: protocol_1.PLUGIN_ID, tool: agent_tool_contracts_1.cellarAgentTools.refetchPartition, handler: handlers.refetchPartition });
    (0, agent_bridge_1.useRozenitePluginAgentTool)({ pluginId: protocol_1.PLUGIN_ID, tool: agent_tool_contracts_1.cellarAgentTools.clearEtag, handler: handlers.clearEtag });
}
