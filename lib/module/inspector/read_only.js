"use strict";

/**
 * Keeps a query typed into a development tool from changing the database it inspects. The query runs on the app's own
 * connection, where a write would land under the store's feet, and where a pragma that sets something would change how
 * the store's own statements behave, so only statements that read are let through.
 */

import { readRows } from "../table/connection.js";

/** One statement, with its comments and trailing semicolons gone, and its leading keyword. */

/** Thrown for a statement the inspector won't run, with a message saying why. */
export class ReadOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyViolation';
  }
}
const READ_VERBS = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN', 'PRAGMA']);

/**
 * Pragmas that take an argument and still only read: each names a table, an index or a limit to report on. Any other
 * pragma with an argument sets something, such as `journal_mode(DELETE)`, and is refused; without one, every pragma
 * reads.
 */
const PRAGMAS_READING_AN_ARGUMENT = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check', 'integrity_check', 'quick_check']);

/**
 * The statement's text with its comments removed and its string literals kept, and whether it held a `;` with more
 * after it (a second statement).
 */
function scan(sql) {
  let text = '';
  let multiple = false;
  let ended = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      text += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          // A doubled quote inside a quoted string or name is the quote itself.
          if (close !== ']' && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      if (ended) multiple = true;
      text += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      ended = true;
      i += 1;
      continue;
    }
    if (ended && !/\s/.test(ch)) multiple = true;
    if (!ended) text += ch;
    i += 1;
  }
  return {
    text: text.trim(),
    multiple
  };
}

/**
 * Parses `sql` as the one statement the inspector will run, throwing a {@linkcode ReadOnlyViolation} for more than one
 * statement, for a statement that isn't a read, and for a pragma that sets something.
 */
export function parseReadStatement(sql) {
  const {
    text,
    multiple
  } = scan(sql);
  if (!text) throw new ReadOnlyViolation('The query is empty.');
  if (multiple) throw new ReadOnlyViolation('Run one statement at a time.');
  const verb = (/^[A-Za-z]+/.exec(text)?.[0] ?? '').toUpperCase();
  if (!READ_VERBS.has(verb)) {
    throw new ReadOnlyViolation(`Only reads run here (SELECT, WITH, VALUES, EXPLAIN, PRAGMA); this is a${/^[AEIOU]/.test(verb) ? 'n' : ''} ${verb || 'unknown'} statement.`);
  }
  if (verb === 'PRAGMA') {
    const pragma = /^PRAGMA\s+(?:[A-Za-z_][\w]*\s*\.\s*)?([A-Za-z_][\w]*)\s*(.*)$/is.exec(text);
    if (!pragma) throw new ReadOnlyViolation('That pragma could not be read.');
    const [, name, rest] = pragma;
    if (rest.trim().startsWith('=')) throw new ReadOnlyViolation(`PRAGMA ${name} = … sets a value; only the reading form runs here.`);
    if (rest.trim() && !PRAGMAS_READING_AN_ARGUMENT.has(name.toLowerCase())) {
      throw new ReadOnlyViolation(`PRAGMA ${name}(…) sets a value; only the reading form, without an argument, runs here.`);
    }
  }
  return {
    sql: text,
    verb
  };
}

/**
 * Throws a {@linkcode ReadOnlyViolation} if the statement would open a write transaction, as `WITH … DELETE` does.
 * Asks SQLite rather than reading the text: the statement's compiled program opens its transaction with
 * `Transaction p2 ≠ 0` exactly when it writes, to any database, `TEMP` included. `EXPLAIN` and `PRAGMA` need no check,
 * since an `EXPLAIN` only compiles its statement and {@linkcode parseReadStatement} has already vetted the pragma.
 */
export function assertCompilesToRead(conn, statement, params) {
  if (statement.verb === 'EXPLAIN' || statement.verb === 'PRAGMA') return;
  const program = readRows(conn, `EXPLAIN ${statement.sql}`, params);
  if (program.some(step => step.opcode === 'Transaction' && Number(step.p2) !== 0)) {
    throw new ReadOnlyViolation('That statement writes to the database; only reads run here.');
  }
}

/** Whether the statement is one whose rows can be wrapped in `SELECT * FROM (…) LIMIT n`. */
export function isWrappable(statement) {
  return statement.verb === 'SELECT' || statement.verb === 'WITH' || statement.verb === 'VALUES';
}
//# sourceMappingURL=read_only.js.map