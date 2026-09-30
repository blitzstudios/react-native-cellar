"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useCellarDevTools = useCellarDevTools;
const plugin_bridge_1 = require("@rozenite/plugin-bridge");
const react_1 = require("react");
const protocol_1 = require("../shared/protocol");
const agent_tools_1 = require("./agent_tools");
const handlers_1 = require("./handlers");
const operations_1 = require("./operations");
/**
 * Connects the app's Cellar stores to the Cellar DevTools panel and registers the Cellar agent tools. Call it once,
 * near the root of the app; a release build gets a hook that does nothing.
 */
function useCellarDevTools() {
    const client = (0, plugin_bridge_1.useRozeniteDevToolsClient)({ pluginId: protocol_1.PLUGIN_ID });
    (0, react_1.useEffect)(() => (client ? (0, handlers_1.registerCellarHandlers)(client, operations_1.defaultInspector) : undefined), [client]);
    (0, agent_tools_1.useCellarAgentTools)(operations_1.defaultInspector);
}
