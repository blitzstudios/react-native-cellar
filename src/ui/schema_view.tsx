import { useEffect, useState } from 'react';
import type { StoreOverview } from '../shared/protocol';
import { ErrorBanner } from './components';
import { formatAgo } from './format';
import { errorMessage, useNow } from './use_cellar';
import type { CellarRpc } from './use_cellar';

/** A store's table as declared, where it runs, and the SQL SQLite holds for it. */
export function SchemaView({ rpc, store }: { rpc: CellarRpc | null; store: StoreOverview }) {
  const { schema, summary } = store;
  const [definitions, setDefinitions] = useState<Array<{ type: string; name: string; sql: string | null }>>();
  const [error, setError] = useState<string>();
  const now = useNow(5000);
  const master = summary.binding.state === 'memory' ? 'sqlite_temp_master' : 'sqlite_master';

  useEffect(() => {
    if (!rpc) return;
    rpc
      .method('query')
      .invoke({ store: store.name, sql: `SELECT type, name, sql FROM ${master} WHERE tbl_name IN (?, ?) ORDER BY type DESC, name`, params: [schema.table, schema.metaTable] })
      .then((result) => setDefinitions(result.rows.map(([type, name, sql]) => ({ type: String(type), name: String(name), sql: sql as string | null }))))
      .catch((caught) => setError(errorMessage(caught)));
  }, [rpc, store.name, master, schema.table, schema.metaTable]);

  const indexed = new Set(schema.indexes.flatMap((index) => index.columns));

  return (
    <div className="schema-view">
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
          <dt>Primary key</dt>
          <dd className="chips">{schema.primaryKey.length ? schema.primaryKey.map((column) => <code key={column}>{column}</code>) : <span className="muted">none: rows repeat</span>}</dd>
          <dt>Writes rows</dt>
          <dd>{schema.nativeShred ? 'with the native shredder' : 'in JS'}</dd>
          <dt>Database</dt>
          <dd>
            {summary.binding.database ? <code>{summary.binding.database}</code> : <span className="muted">unnamed</span>} · since {formatAgo(summary.binding.since, now)}
            {summary.binding.reopens ? ` · reopened ${summary.binding.reopens}×` : ''}
          </dd>
          <dt>Reads</dt>
          <dd className="chips">{schema.reads.length ? schema.reads.map((read) => <code key={read}>{read}</code>) : <span className="muted">none built yet</span>}</dd>
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
              const keyPosition = schema.primaryKey.indexOf(column.name);
              return (
                <tr key={column.name}>
                  <td>
                    <code>{column.name}</code>
                  </td>
                  <td>{column.type}</td>
                  <td>{column.notNull ? 'not null' : <span className="muted">nullable</span>}</td>
                  <td className="chips">
                    {keyPosition >= 0 ? <span className="tag">PK {keyPosition + 1}</span> : null}
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
        <h4>As SQLite holds it</h4>
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
