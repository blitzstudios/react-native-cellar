import { useRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { useEffect, useMemo } from 'react';
import { PLUGIN_ID } from '../shared/protocol';
import type { CellarEventMap } from '../shared/protocol';
import { useCellarAgentTools } from './agent_tools';
import { registerCellarHandlers } from './handlers';
import { defaultInspector, nitroDump } from './operations';

/** Options for {@linkcode useCellarDevTools}. */
export interface CellarDevToolsOptions {
  /** The database file name a dump writes, in nitro's directory; `cellar-dump.db` by default. */
  dumpName?: string;
}

/**
 * Connects the app's Cellar stores to the Cellar DevTools panel and registers the Cellar agent tools. Call it once,
 * near the root of the app; a release build gets a hook that does nothing.
 */
export function useCellarDevTools(options: CellarDevToolsOptions = {}): void {
  const client = useRozeniteDevToolsClient<CellarEventMap>({ pluginId: PLUGIN_ID });
  const dump = useMemo(() => nitroDump(options.dumpName), [options.dumpName]);
  useEffect(() => (client ? registerCellarHandlers(client, defaultInspector, dump) : undefined), [client, dump]);
  useCellarAgentTools(defaultInspector, dump);
}
