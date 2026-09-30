"use strict";
/**
 * What the app and the panel say to each other. The panel calls the app's methods over Rozenite's RPC; the app pushes
 * what the stores do, in batches, as `cellar:events`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DUMP_CHUNK_BYTES = exports.PLUGIN_ID = void 0;
exports.PLUGIN_ID = '@sleeperhq/rozenite-plugin-cellar';
/** The most bytes of a dump one `readDump` answers. */
exports.DUMP_CHUNK_BYTES = 1024 * 1024;
