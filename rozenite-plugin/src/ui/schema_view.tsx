import { useEffect, useState } from 'react';
import type { StoreOverview } from '../shared/protocol';
import { ErrorBanner } from './components';
import { formatAgo, formatCount, quoteName } from './format';
import { errorMessage, useNow } from './use_cellar';
import type { CellarRpc } from './use_cellar';

/** A store's table as declared, how its rows are stored, where it runs, and the SQL SQLite holds for it. */
export function SchemaView({ rpc, store, onQuery }: { rpc: CellarRpc | null; store: StoreOverview; onQuery: (sql: string) => void }) {
  const { schema, summary } = store;
  const rowsTable = `${schema.table}__rows`;
  const membersTable = `${schema.table}__members`;
  const queryButton = (name: string) => (
    <button type="button" className="button button-small" onClick={() => onQuery(`SELECT *\nFROM ${quoteName(name)}\nLIMIT 100`)}>
      Query
    </button>
  );
  const [definitions, setDefinitions] = useState<Array<{ type: string; name: string; sql: string | null }>>();
  const [error, setError] = useState<string>();
  const now = useNow(5000);
  const master = summary.binding.state === 'memory' ? 'sqlite_temp_master' : 'sqlite_master';

  useEffect(() => {
    if (!rpc) return;
    rpc
      .method('query')
      .invoke({
        store: store.name,
        sql: `SELECT type, name, sql FROM ${master} WHERE tbl_name IN (?, ?, ?, ?) ORDER BY type DESC, name`,
        params: [schema.table, `${schema.table}__rows`, `${schema.table}__members`, schema.metaTable],
      })
      .then((result) => {
        const at = (column: string) => result.columns.indexOf(column);
        const [type, name, sql] = [at('type'), at('name'), at('sql')];
        setDefinitions(result.rows.map((row) => ({ type: String(row[type]), name: String(row[name]), sql: row[sql] as string | null })));
      })
      .catch((caught) => setError(errorMessage(caught)));
  }, [rpc, store.name, master, schema.table, schema.metaTable]);

  const indexed = new Set(schema.indexes.flatMap((index) => index.columns));

  return (
    <div className="schema-view">
      {summary.storedRows === undefined ? null : (
        <section>
          <h4>Storage</h4>
          <p className="muted small">
            <code>{schema.table}</code> is a view. Each row is stored once in <code>{rowsTable}</code>, however many partitions hold it, and{' '}
            <code>{membersTable}</code> lists which partitions hold which rows. The view joins the two: one row per partition holding a row.
          </p>
          <table className="table">
            <tbody>
              <tr>
                <td>
                  <code>{rowsTable}</code>
                </td>
                <td>table</td>
                <td className="num">{formatCount(summary.storedRows)} rows</td>
                <td className="actions">{queryButton(rowsTable)}</td>
              </tr>
              <tr>
                <td>
                  <code>{membersTable}</code>
                </td>
                <td>table</td>
                <td className="num">{formatCount(summary.rows)} memberships</td>
                <td className="actions">{queryButton(membersTable)}</td>
              </tr>
              <tr>
                <td>
                  <code>{schema.table}</code>
                </td>
                <td>view</td>
                <td className="num">{formatCount(summary.rows)} rows</td>
                <td className="actions">{queryButton(schema.table)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}
      <section className="facts">
        <dl>
          <dt>Table</dt>
          <dd>
            <code>{schema.table}</code>
          </dd>
          <dt>ETag table</dt>
          <dd>
            <code>{schema.metaTable}</code>
          </dd>
          <dt>Entity column</dt>
          <dd>
            <code>{schema.entityColumn}</code>
          </dd>
          <dt>Unique by</dt>
          <dd className="chips">{schema.uniqueBy.length ? schema.uniqueBy.map((column) => <code key={column}>{column}</code>) : <span className="muted">none</span>}</dd>
          <dt>Writes rows</dt>
          <dd>{schema.nativeShred ? 'native shredder' : 'JS'}</dd>
          <dt>Database</dt>
          <dd>
            {summary.binding.database ? <code>{summary.binding.database}</code> : <span className="muted">unnamed</span>} · since {formatAgo(summary.binding.since, now)}
            {summary.binding.reopens ? ` · reopened ${summary.binding.reopens}×` : ''}
          </dd>
          <dt>Reads</dt>
          <dd className="chips">{schema.reads.length ? schema.reads.map((read) => <code key={read}>{read}</code>) : <span className="muted">none</span>}</dd>
        </dl>
      </section>
      <section>
        <h4>Columns</h4>
        <table className="table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Null</th>
              <th>Key</th>
            </tr>
          </thead>
          <tbody>
            {schema.columns.map((column) => {
              const uniquePosition = schema.uniqueBy.indexOf(column.name);
              return (
                <tr key={column.name}>
                  <td>
                    <code>{column.name}</code>
                  </td>
                  <td>{column.type}</td>
                  <td>{column.notNull ? 'not null' : <span className="muted">nullable</span>}</td>
                  <td className="chips">
                    {uniquePosition >= 0 ? <span className="tag">unique {uniquePosition + 1}</span> : null}
                    {column.name === schema.entityColumn ? <span className="tag">entity</span> : null}
                    {indexed.has(column.name) ? <span className="tag tag-muted">indexed</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section>
        <h4>Indexes</h4>
        <table className="table">
          <tbody>
            {schema.indexes.map((index) => (
              <tr key={index.name}>
                <td>
                  <code>{index.name}</code>
                </td>
                <td>{index.columns.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h4>CREATE statements</h4>
        {error ? <ErrorBanner message={error} /> : null}
        {definitions?.map((definition) => (
          <pre key={definition.name} className="json">
            {definition.sql ?? `-- ${definition.type} ${definition.name} (created by SQLite)`}
          </pre>
        ))}
      </section>
    </div>
  );
}
