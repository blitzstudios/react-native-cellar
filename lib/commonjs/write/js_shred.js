"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.shredCommandStatements = shredCommandStatements;
var _shred_spec = require("./shred_spec.js");
/**
 * A native shred run in JS: the statements a {@linkcode ShredCommand} writes, with the body parsed and each element's
 * row built by the spec's reference interpreter. What a connection without the C++ shred runs: sql.js in tests, and the
 * Node writer, off the main thread.
 */

function shredStatements(spec, rows, binds) {
  const commands = [];
  const deleteWhere = spec.deleteWhere ?? [];
  if (deleteWhere.length) {
    const where = deleteWhere.map(column => `${column.column} = ?`).join(' AND ');
    commands.push([`DELETE FROM ${spec.table} WHERE ${where};`, deleteWhere.map(column => binds[column.bindIndex] ?? null)]);
  }
  const placeholders = spec.columns.map(() => '?').join(', ');
  const insert = `${spec.insertVerb} INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${placeholders});`;
  for (const row of rows) commands.push([insert, spec.columns.map(column => row[column] ?? null)]);
  return commands;
}

/** The statements one shred command runs: its delete, then one insert per element of the body. */
function shredCommandStatements({
  shred: spec,
  rawJson,
  binds
}) {
  const parsed = JSON.parse(rawJson);
  const elements = spec.source === 'objectValues' ? Object.values(parsed) : parsed;
  return shredStatements(spec, (0, _shred_spec.evalShredSpec)(spec, elements, binds), binds);
}
//# sourceMappingURL=js_shred.js.map