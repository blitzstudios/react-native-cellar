# @sleeperhq/rozenite-plugin-cellar

A [Rozenite](https://www.rozenite.dev) panel for React Native DevTools that shows an app's
[Cellar](../README.md) stores as they run: every store and where it runs, each partition's rows, version, ETag
and last fetch, read-only SQL over a store's live database that re-runs as the store writes, and a feed of what
the stores do — writes, fetches, moves between databases and degradation reports. The same view is open to
agents (Cursor, Claude, the Rozenite CLI) as tools.

It reads everything through Cellar's `./inspector` entry, so it needs `@sleeperhq/react-native-cellar` 1.2.13 or
later. Nothing it does changes a store's rows: a query that would write is refused, and its only actions are
refetching a partition and clearing its ETag, which a store does on its own anyway.

## Setup

1. Rozenite itself, once per app: `@rozenite/metro` as a dev dependency, and the Metro config wrapped in
   `withRozenite`, enabled by an environment variable so an ordinary `yarn start` is untouched:

   ```js
   // metro.config.js
   const { withRozenite } = require('@rozenite/metro');

   module.exports = withRozenite(config, { enabled: process.env.WITH_ROZENITE === 'true' });
   ```

2. The plugin, as a dependency of the package Metro runs from (Rozenite discovers plugins in that package's
   `dependencies` and `devDependencies`):

   ```json
   "@sleeperhq/rozenite-plugin-cellar": "blitzstudios/react-native-cellar.git#rozenite-plugin-cellar-v1.0.4-gitpkg"
   ```

3. The hook, once, near the app's root. A release build gets a hook that does nothing, and the rest of the plugin
   stays out of its bundle:

   ```tsx
   import { useCellarDevTools } from '@sleeperhq/rozenite-plugin-cellar';

   function App() {
     useCellarDevTools();
     // …
   }
   ```

Then start Metro with `WITH_ROZENITE=true`, open React Native DevTools (`j` in Metro), and pick the **Cellar** panel.

## The panel

- **Overview** — every store with where it runs (its own database, the in-memory fallback, or unbound), its rows,
  partitions, size on disk and writes per minute; each store's recent fetches, with the request and the write averaged
  per fetch and totalled; and every degradation, grouped by rule and subject with its count, its numbers and the code
  that caused it (the component chain or JS stack, symbolicated through Metro).
- **Activity** — what every store did, newest first.
- **Partitions** — each partition of a store with its rows, entities, version, ETag and when it last landed,
  sortable and filterable, updating as the store writes. A partition opens to its description, its recent writes and
  fetches, and the entities it changed lately, and has actions: query its rows, refetch it, clear its ETag.
- **Query** — one read-only statement at a time (`SELECT`, `WITH`, `VALUES`, `EXPLAIN`, a reading `PRAGMA`) on the
  store's live database, with `?` params, a page size with next and previous pages, snippets and history. **Live** re-runs the query whenever
  the store writes. A cell opens to its whole value, pretty-printed when it holds JSON; results copy as JSON or
  CSV. Queries go to the store's dedicated reader when it has one, so they don't hold up its writes.
- **Activity** — what the store did, newest first, filterable by kind and by partition, entity id or scope, with
  pause.
- **Caches** — the values the store keeps on the JS heap, per partition or per entity: entries against the limit,
  an estimate of the heap they hold, hit rate, stale and absent misses, evictions, evicted keys read again (what a
  larger cache would have answered), builds and `isEqual` reuses, with a cache that never hits or is too small called
  out. A cache opens to its entries, newest first: each key, version, heap estimate and value.
- **Schema** — the table as declared (columns, primary key, entity column, indexes, reads) and the `CREATE`
  statements SQLite stored for it.

The app records events in development builds only, the latest 1000; the panel keeps the latest 5000 it has seen.

## Agent tools

Registered under `@sleeperhq/rozenite-plugin-cellar` while the hook is mounted:

| tool | what it does |
| --- | --- |
| `list-stores` | every store, its table, where it runs, and its row and partition totals |
| `describe-store` | a store's columns, primary key, entity column, indexes and reads |
| `list-partitions` | a store's partitions, optionally matching a key, with rows, version, ETag and last fetch |
| `query` | one read-only statement over a store's live database, a page at a time |
| `entity-changes` | the entities a partition changed lately, with the version each changed at |
| `list-caches` | the stores' caches with their entries, heap estimate, hits, misses, evictions and builds |
| `cache-entries` | a page of one cache's entries: key, version, heap estimate and value |
| `recent-events` | recent writes, binding moves, fetches and degradation reports, filterable by store and kind |
| `ingest-timings` | the latest fetches with request and write time, and totals per store |
| `refetch-partition` | fetches a partition again |
| `clear-etag` | deletes a partition's ETag, so its next fetch brings the whole body |

## Development

This directory is its own Yarn project, apart from Cellar's:

```sh
yarn install
yarn test        # the app side and the panel against each other, over Cellar's source one directory up
yarn typecheck   # against Cellar's built declarations, so build Cellar first
yarn build       # writes dist/
```

For a panel that reloads as you edit it, run `yarn dev` here and start the app's Metro with
`ROZENITE_DEV_MODE=@sleeperhq/rozenite-plugin-cellar`.

**`dist/` is committed.** An app installs this from a git tag and never builds it, so a change to the source isn't
released until `yarn build` runs and its output is committed; CI fails when `dist/` doesn't match.

## Release

The plugin ships from its own tag, whose commit holds only this directory: bump `version` here, build, commit, then
tag a commit of `git subtree split --prefix rozenite-plugin` as `rozenite-plugin-cellar-v<version>-gitpkg`.
