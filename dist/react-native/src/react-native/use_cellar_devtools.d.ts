/** Options for {@linkcode useCellarDevTools}. */
export interface CellarDevToolsOptions {
    /** The database file name a dump writes, in nitro's directory; `cellar-dump.db` by default. */
    dumpName?: string;
}
/**
 * Connects the app's Cellar stores to the Cellar DevTools panel and registers the Cellar agent tools. Call it once,
 * near the root of the app; a release build gets a hook that does nothing.
 */
export declare function useCellarDevTools(options?: CellarDevToolsOptions): void;
