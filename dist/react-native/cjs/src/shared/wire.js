"use strict";
/**
 * How results cross the bridge: as JSON text. Rozenite's bridge copies each message with a structured clone that walks
 * every value in JS, so a 500-row result costs the app tens of thousands of steps per message; `JSON.stringify` is
 * native, and the bridge copies the one string it returns in a single step.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsingRpc = parsingRpc;
/** Wraps the wire RPC so each call parses its JSON result. */
function parsingRpc(rpc) {
    return {
        method: (name, options) => ({
            invoke: async (...params) => {
                const handle = rpc.method(name, options);
                return JSON.parse(await handle.invoke(...params));
            },
        }),
    };
}
