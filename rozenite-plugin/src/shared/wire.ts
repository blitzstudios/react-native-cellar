/**
 * How results cross the bridge: as JSON text. Rozenite's bridge copies each message with a structured clone that walks
 * every value in JS, so a 500-row result costs the app tens of thousands of steps per message; `JSON.stringify` is
 * native, and the bridge copies the one string it returns in a single step.
 */

import type { InvokeOptions, RozeniteRpc } from '@rozenite/plugin-bridge';
import type { CellarMethods } from './protocol';

/** {@linkcode CellarMethods} as they travel: each resolves with its result as JSON text. */
export type CellarWireMethods = {
  [K in keyof CellarMethods]: CellarMethods[K] extends (...args: infer A) => Promise<unknown> ? (...args: A) => Promise<string> : never;
};

type ParamsOf<K extends keyof CellarMethods> = Parameters<CellarMethods[K]>;
type ResultOf<K extends keyof CellarMethods> = Awaited<ReturnType<CellarMethods[K]>>;

/** The panel's view of the app's methods: called by name, resolving with the parsed result. */
export interface CellarRpc {
  method<K extends keyof CellarMethods>(name: K, options?: InvokeOptions): { invoke(...params: ParamsOf<K>): Promise<ResultOf<K>> };
}

/** Wraps the wire RPC so each call parses its JSON result. */
export function parsingRpc(rpc: RozeniteRpc<CellarWireMethods>): CellarRpc {
  return {
    method: (name, options) => ({
      invoke: async (...params) => {
        const handle = rpc.method(name, options) as unknown as { invoke: (...args: unknown[]) => Promise<string> };
        return JSON.parse(await handle.invoke(...params));
      },
    }),
  };
}
