"use strict";

/**
 * The web half of Cellar: binding a store to sql.js, the SQLite engine compiled to WebAssembly. Kept behind its own
 * entry point so a device bundle never reaches it.
 */

export { bindSqlJsStore, openSqlJsConnection } from "./sqljs_connection.js";
//# sourceMappingURL=index.js.map