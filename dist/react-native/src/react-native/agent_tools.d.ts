/** Registers the Cellar agent tools with Rozenite while the calling component is mounted. */
import type { CellarInspector, DumpDatabases } from './operations';
/** Registers every Cellar agent tool while the calling component is mounted. */
export declare function useCellarAgentTools(inspector?: CellarInspector, dump?: DumpDatabases): void;
