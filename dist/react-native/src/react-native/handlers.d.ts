/** Answers the panel's calls, and pushes the stores' events to it as they are recorded. */
import type { RozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import type { CellarEventMap } from '../shared/protocol';
import type { CellarInspector, DumpDatabases, OpenDeviceFile } from './operations';
/** How long events gather before they go to the panel in one message, in ms. */
export declare const EVENT_FLUSH_MS = 100;
/** The most events one message carries; a busier interval goes out as several. */
export declare const EVENTS_PER_MESSAGE = 250;
/** Wires `client` up to answer the panel, and returns a function that unwires it. */
export declare function registerCellarHandlers(client: RozeniteDevToolsClient<CellarEventMap>, inspector?: CellarInspector, dump?: DumpDatabases, openFile?: OpenDeviceFile): () => void;
