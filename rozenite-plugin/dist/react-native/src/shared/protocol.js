/**
 * What the app and the panel say to each other. The panel calls the app's methods over Rozenite's RPC; the app pushes
 * what the stores do, in batches, as `cellar:events`.
 */
export const PLUGIN_ID = '@sleeperhq/rozenite-plugin-cellar';
/** The most bytes of a dump one `readDump` answers. */
export const DUMP_CHUNK_BYTES = 1024 * 1024;
