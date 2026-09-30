import { useRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { useEffect } from 'react';
import { PLUGIN_ID } from '../shared/protocol';
import type { CellarEventMap } from '../shared/protocol';
import { useCellarAgentTools } from './agent_tools';
import { registerCellarHandlers } from './handlers';
import { defaultInspector } from './operations';

/**
 * Connects the app's Cellar stores to the Cellar DevTools panel and registers the Cellar agent tools. Call it once,
 * near the root of the app; a release build gets a hook that does nothing.
 */
export function useCellarDevTools(): void {
  const client = useRozeniteDevToolsClient<CellarEventMap>({ pluginId: PLUGIN_ID });
  useEffect(() => (client ? registerCellarHandlers(client, defaultInspector) : undefined), [client]);
  useCellarAgentTools(defaultInspector);
}
