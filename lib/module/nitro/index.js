"use strict";

/**
 * The on-device half of Cellar: opening a SQLite database through `react-native-nitro-sqlite` and binding a
 * store to it. Kept behind its own entry point so the core stays runnable off-device.
 */

export { openNitroConnection, getOpenSqliteConnections, bindSqliteStore, retrySqliteStores } from "./nitro_connection.js";
export { dumpSqliteStores } from "./dump.js";
//# sourceMappingURL=index.js.map