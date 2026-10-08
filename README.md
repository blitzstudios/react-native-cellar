# Cellar

`@sleeperhq/react-native-cellar` keeps a React Native app's large server data off the JS heap, in SQLite, while
components read it synchronously and re-render only for what changed. A whole sport's players or a week's stats stay in
the database, and only what is on screen is ever built in JS, so garbage collection has far less to do.

Underneath, that is all this is: a reactive wrapper around a SQLite database. You declare a table, how a slice of
it is fetched, and what each read hands back. Cellar owns the SQL, the conditional fetch, the caching and the
re-render.

```ts
const { data: items, isLoading } = GroupItems.useValue({ params: { groupId } });
```

That read is subscribed to one slice of one table. It fetches the slice if the database doesn't have it yet,
re-renders when a row in it changes, and re-renders nothing when a row outside it does.

## Concepts

A store's table is divided into partitions, and each row belongs to an entity.

| term | what it is |
| --- | --- |
| **store** | one SQLite table and the reads and fetches over it, declared with `defineSqliteStore`. On device the table lives in the device's SQLite; on the web and in tests, in sql.js |
| **partition** | the set of rows one fetch returns and replaces, described by the args that name it (`{ groupId: 'g1' }`). Each has its own fetch, ETag and version |
| **key** | the string a partition is identified by (`'g1'`): Cellar derives it from the description, stamps it on every row in a `partition_key` column, and files the partition's ETag, version and request under it. Keys name partitions; ids name entities |
| **entity** | the rows in a partition that share one `entityId` value, defined in the table's schema, such as one item's rows. It is how finely Cellar tracks change: a write reports the entities it changed, and a read that looked up particular entities re-runs only when a row of one of them changes. An entity can be read before it has any rows, and wakes its readers when they arrive |
| **change set** | what a write changed: the entity id of every row it added, changed or removed. The write replaces those entities' rows, then bumps the partition's version and the version of each changed entity |
| **read** | a query declared on a store, used as a hook or a getter. It fetches its partition if needed, and recomputes when what it depends on changes: a read that asks for particular entities (through a `byEntity` cache) depends on those entities; one that looks at the whole partition depends on the partition. The component re-renders only if the recomputed value differs. A read caches nothing itself: its values come from the store's caches |
| **cache** | a store's values built from rows, declared in `defineCaches`: one value per entity (`byEntity`), rebuilt when that entity's rows change, or per partition and any key parts (`byPartition`), rebuilt when anything in the partition changes. The value is whatever the store builds, often a view model |
| **shred** | turning a JSON response into rows: in C++ from a `NativeShredSpec`, so no JS object is built per row, or in JS from each column's `op` or `js` builder |

## Why

A reference dataset held in JS costs heap for as long as the process lives — every object, on every launch,
whether or not anything is on screen, plus whatever the garbage collector spends walking it. Held in SQLite, the
resident cost is the slice being looked at.

Doing that one dataset at a time by hand means re-solving the same problems each time: a schema and its
migrations, a conditional fetch, rows back into view models, invalidation, and getting React to re-render the
components that care and no others. That is what this package is.

## Requirements

React 17 or newer and `@tanstack/query-core` 4 or newer. Every store runs on SQLite, and every query is written once:
on device it comes from `react-native-nitro-sqlite` through the `./nitro` entry point, and on the web from sql.js, the
same engine compiled to WebAssembly, through `./sqljs`. Tests use sql.js too, through `./testing`.

## Install

```jsonc
// package.json
"@sleeperhq/react-native-cellar": "blitzstudios/react-native-cellar.git#react-native-cellar-v1.3.14-gitpkg",
// On device, the SQLite driver `./nitro` opens databases with, 1.1.5 or later. An app that runs Cellar only on the
// web or in tests leaves it out.
"react-native-nitro-sqlite": "blitzstudios/react-native-nitro-sqlite.git#react-native-nitro-sqlite-v1.1.5-gitpkg"
```

## Quick start

A store is a table, the partitions that divide it into fetchable slices, and one or more reads. The store below holds
items belonging to a group, fetched one group at a time.

### 1. Declare the columns

One entry per persisted column. The row type and the `CREATE TABLE` are both generated from this, so adding a
field means adding a column here and nothing else.

```ts
import { defineShredColumns, RowOf, ShredColumn, StoreTableSchema } from '@sleeperhq/react-native-cellar';

type RawItem = { id: string; name?: string; rank?: number };

export const ITEM_COLUMNS = [
  { name: 'item_id', type: 'TEXT', notNull: true, js: (item: RawItem): string => item.id },
  { name: 'name', type: 'TEXT', js: (item: RawItem) => item.name ?? null },
  { name: 'rank', type: 'INTEGER', js: (item: RawItem) => item.rank ?? null },
] as const satisfies readonly ShredColumn<RawItem>[];

export type ItemRow = RowOf<typeof ITEM_COLUMNS>;
export const itemShred = defineShredColumns<RawItem>()(ITEM_COLUMNS);

export const itemSchema: StoreTableSchema<ItemRow> = {
  table: 'items',
  columns: itemShred.columnDefs,
  uniqueBy: ['item_id'],
  // Each row belongs to one item: writes report the items they changed, and a read of particular items recomputes only
  // when one of those changes.
  entityId: 'item_id',
};
```

A column an op can describe declares the op instead of a builder: `{ name: 'name', type: 'TEXT', op: { op: 'text',
path: 'name' } }`. The JS row builder runs the op the way the native shredder does, so a store that shreds natively
writes the same value on either path, and the row type follows the op (`text` is `string | null`). A value no op can
express, such as a field that falls back to what the store passes for the write, keeps a `js` builder; a native store
gives it an op too, and its parity test holds the two together. `shredColumnValue(column, src, ctx)` computes one
column as the row builder would, for building part of a row.

The same table reads a stored row back. `itemShred.decode(row, ['item_id', 'name'])` returns those columns as JS
values, which is most of building a view model: a `boolInt` reads as a boolean, a `rawJsonField` is parsed, and a NULL
reads as `undefined`, or as `null` with `{ absent: null }`. A column whose stored value needs more than that, such as
a JSON list validated into strings, declares its own `decode`.

These describe `items__rows`, where each row is stored once by its `uniqueBy` columns. Cellar adds the rest: an
`items__members` table naming each partition's rows, a view under the name `items` joining the two with each row's
`partition_key`, an index on the entity id, and a side table (`items_meta`) holding each partition's ETag and description.

### 2. Declare the store: its partitions and its reads

`partition` turns a read's args into the partition it reads, here `{ groupId }`, or `null` until the args are
complete, and Cellar derives the rest from that description: the partition's key (the description serialized, here `groupId=g1`), what a fetch replaces, where the ETag
goes, what a write bumps. `fetch` gets the description. `build` declares the reads, which turn a partition's rows into
whatever the screen actually wants, and the caches that hold what they build, with what its one argument, `cellar`,
hands it.

```ts
import { byPartition, defineSqliteStore, Loose } from '@sleeperhq/react-native-cellar';

export type ItemKey = { groupId: string };
export type ItemVM = { id: string; name: string };

const NO_ITEMS: ItemVM[] = [];
const toVM = (row: ItemRow): ItemVM => ({ id: row.item_id, name: row.name ?? '' });

export const itemStore = defineSqliteStore({
  name: 'item_store',
  schema: itemSchema,
  partition: ({ groupId }: Loose<ItemKey>) => (groupId ? { groupId } : null),
  fetch: ({ groupId }: ItemKey) => ({
    query: {
      queryFn: async ({ etag }) => {
        const response = await fetch(`/groups/${groupId}/items`, { headers: etag ? { 'If-None-Match': etag } : {} });
        if (response.status === 304) return { __etagMatch: true };
        return { data: await response.text(), etag: response.headers.get('etag') ?? undefined };
      },
    },
    toRows: (rawJson) => (JSON.parse(rawJson) as RawItem[]).map((item) => itemShred.row(item)),
  }),
  build: (cellar) => {
    const { groupItems } = cellar.defineCaches({
      // One list per group, built on first use and again after a write to that group.
      groupItems: byPartition<ItemVM[]>({ max: 16 }),
    });

    return {
      reads: {
        GroupItems: cellar.defineRead<ItemKey, ItemVM[]>({
          select: (_args, key) => groupItems.for(key).read(() => cellar.rows(key, undefined, { orderBy: 'rank' }).map(toVM, NO_ITEMS)),
          empty: NO_ITEMS,
        }),
      },
    };
  },
});
```

`select` gets the read's args and its partition's key, runs only once the partition holds rows, and a hook runs it
again only when something it read has changed. A read caches nothing itself, so what `select` builds, it builds inside
one of the store's caches: here, every caller of one group shares one list. `empty` is what callers get before the
partition has rows, so it has to be a stable reference. The store's `lifecycle` (priming, fetching, refetching,
forgetting) comes from Cellar; `build` returns only the reads, and any pushes or lifecycle functions of its own.

The partition's type comes from what `partition` returns, here `ItemKey`. Args a read takes beyond the description,
such as an item id, pick rows within the partition; a read that wants another partition names it with its own `partition`. A read of several partitions at once, such as one
player's stats across several weeks, is a `defineReadAcross`, whose `partitions` names them from the args.

Until it is bound, a store runs over a connection that answers nothing, so each read gives back its `empty`. Startup
binds it (step 4). On device, a read whose own statement fails (a query bug, or a value `json_extract` cannot parse) is
reported once and answers empty, and the connection carries on. Any other SQLite failure mid-session reopens the
database, deleting it first when the file is what failed, and after two failed reopens moves the store to a private
in-memory database, which needs no file: the same SQLite, with the store's tables in the connection's temp schema.
`build` runs again each time the store moves, so it holds nothing outside what it returns — and `itemStore.reads` always reaches
whichever connection is running, so callers hold the store rather than anything taken off it.

#### Priming is by partition, not by what a read selects

Reading a cold partition fetches it, automatically, and that is meant to be unremarkable — it is most of why the
layer exists. Worth knowing once, though: the fetch is scoped to the **partition**, never to what the read selects.

```ts
ItemsByIds: cellar.defineRead<ItemIdsKey, ItemVM[]>({
  select: (args, key) => itemsById.atEach(key, args.ids),
  empty: NO_ITEMS,
}),
```

That read asks for a handful of ids. If the store partitions by league and a league holds thirty thousand rows, the
first such read fetches thirty thousand rows. The gap can be three orders of magnitude and it is invisible at the
call site, which sees only `useItemsByIds({ league, ids })`.

This is a property of the store's **fetch granularity**, not of the read, and no setting on the read improves it.
Where it bites, the fixes are:

- at the call site — if the payload that named those ids already carries what you render, render from that and do
  not read the store at all;
- in the store — a narrower partition key, where the API offers one.

`prime: false` exists but is not that fix. It means *never fetch on this read's behalf*, and it is for a read that
guesses across candidate partitions, or a selector over rows something else is responsible for fetching. A read
using it is `empty` until whoever owns the fetch has run.

A read that has nothing to return for some of its args declares `enabled` as a function of them: a bye-week summary
has nothing for a sport without byes, so with `enabled: (args) => args.sport === 'nfl'` it returns `empty` for an NBA
season and fetches nothing for it, while other reads of the store still fetch that season. `prime` takes a function
too, for a read that runs for some args but should leave their fetch to someone else.

Nothing here has to be declared. An ingest landing more than a few thousand rows files one `info` report per
partition per session, which is how an over-large partition makes itself known — including one that was a
reasonable size when the read was written and grew since.

### 3. Publish a read, and call it

`pairRead` publishes each read as both halves at once: a hook for components, and an imperative getter for
everything else. A read declares which args it waits on, so the pair stays inert until a caller has them.

```ts
import { pairRead } from '@sleeperhq/react-native-cellar';

export const GroupItems = pairRead(() => itemStore.reads.GroupItems);
```

```tsx
function ItemList({ groupId }: { groupId?: string }) {
  const { data: items, isLoading } = GroupItems.useValue({ params: { groupId } });

  if (isLoading) return <Spinner />;
  return <List data={items} renderItem={({ item }) => <Row name={item.name} />} />;
}
```

Calling it with no `groupId` is fine: the read addresses nothing, fetches nothing, and hands back `empty`.

### 4. Wire it up at startup

The host installs two services, and binds each store to its platform's SQLite.

```ts
import { configureCellar, reactQueryRuntime } from '@sleeperhq/react-native-cellar';
import { AppState } from 'react-native';
import { bindSqliteStore, retrySqliteStores } from '@sleeperhq/react-native-cellar/nitro';

configureCellar({
  errors: { captureException, captureMessage },
  query: reactQueryRuntime({ client: () => queryClient, useQuery, useQueries }),
  gate: { useReadGate },
});

bindSqliteStore('initItemStore', 'items.db', itemStore);

// A store whose database would not open — a launch in the background before the device's first unlock, say — tries
// again when the app comes back.
AppState.addEventListener('change', (state) => state === 'active' && retrySqliteStores());
```

Each report Cellar files is sent once per session per site. Errors always reach the sink; `info` notices, such as a
store reopening its database, arrive from nearly every session across a large install base, so `infoSampleRate` (0 to
1, default 1) lets the host send a sample. A storage failure, such as a full disk, is sent as an `info` notice: the
store already moved to memory, and nothing in Cellar can fix it. `verbose` reports are advice for a developer, such as an oversized partition
fetch, and `minSeverity` (default `verbose`) is the lowest severity sent:
`errors: { captureException, captureMessage, infoSampleRate: 0.01, minSeverity: 'info' }`. An error is one issue per
kind across stores, with the store in its `cellar_degradation` tag, and every notice shares a single issue.

On the web, the app loads sql.js and binds each store to a database of its own, held in memory for the page:

```ts
import initSqlJs from 'sql.js';
import { bindSqlJsStore } from '@sleeperhq/react-native-cellar/sqljs';

initSqlJs({ locateFile: (file) => `/static/${file}` }).then((SQL) => bindSqlJsStore('items', SQL, itemStore));
```

`useQuery` and `useQueries` are passed in rather than imported, so an app keeps its own fetch policy — focus
gating, retries, whatever it already does. `reactQueryRuntime` takes React Query v4's hooks, or an app's wrappers of
them, with whatever generics they declare. Until `configureCellar` runs Cellar is inert: reads answer
from rows already stored, and nothing fetches.

A database that will not open or migrate is retried once from empty, since it is only a cache. A store that still
cannot bind, or that left its file mid-session, runs on its in-memory database until `retrySqliteStores` moves it
back, at most three times a session. `bindSqliteStore(…, { inMemory: true })` skips the file altogether, which is
what a kill switch wants, and `{ shredInJs: true }` ingests through the JS row builders instead of the native shred,
for a switch over that native code.

`useReadGate` is the same idea for the read side. It answers one question — is this read still taking writes? —
and Cellar never learns why the answer changed, so an app decides whether a blurred screen, a hidden subtree
or a backgrounded app counts:

```ts
const useReadGate = () => {
  const controller = useFocusController();
  return useMemo(() => ({ isLive: () => controller.isFocused, onChange: controller.onFocusChange }), [controller]);
};
```

While a gate is dead its reads drop their subscription and hold the value they last had, then catch up in one
render when it goes live again. They do not blank, and the gate never reaches the render — a read that
re-rendered on gate changes would wake every screen in the stack on each navigation, which is the cost this
avoids. Configure no gate and every read stays live.

A read call takes `meta` as a React Query hook does, and its fetch carries it, so the app's query hooks see what
they would on any other query. A call that has to stay current on a screen that isn't live passes the `meta` those
hooks already let through their own gate, and the app tells `reactQueryRuntime` which `meta` that is, so the read
gate lets it through too:

```ts
query: reactQueryRuntime({ client, useQuery, useQueries, bypassesGates: (meta) => meta.bypassFocusGate === true }),
// …
Stats.Hooks.useStats({ params, options: { meta: { bypassFocusGate: true } } });
```

Other calls of the same read keep following both gates.

## What you get without writing it

- **Conditional fetch.** Each partition keeps its own ETag, so a refetch that hasn't changed costs a 304 and no
  write. Fetches are orchestrated through the host's React Query, deduped and shared between readers.
- **JSON that never becomes objects.** A response body can be shredded from text straight into columns in C++,
  so a large payload is never a JS object graph. Declaring a `NativeShredSpec` is optional; without one the same
  columns are filled in JS, from their ops or their builders.
- **Schema migration with no migration to write.** `init` fingerprints the schema it built. A database whose
  fingerprint no longer matches is migrated on the spot — widened by `ALTER TABLE ADD COLUMN` when the change
  only added columns, rebuilt from the next fetch otherwise.
- **Writes that say what they changed.** Every write compares its rows with what the table holds and reports its
  change set: the entities with a row added, changed or removed. A refetch that brings back what the table already holds
  changes nothing and wakes nobody; a live poll where four players moved wakes the readers of those four.
- **Reactivity per entity, found by reading.** A read subscribes to exactly what it read, discovered by running it: a
  read of named entities through a `byEntity` cache depends on those entities, and a read over the whole partition
  depends on the partition. Nothing is declared, and a read that takes rows straight off the table falls back to its
  whole partition, so precision is never bought with correctness.
- **Stable references for free.** Rows come back from SQLite as fresh objects, so a read rebuilding view models would
  repaint every subscriber. Declare the shape as a `byEntity` cache and Cellar keeps each entity's value (usually a
  view model) until that entity changes, handing back the same reference until then.
- **One query engine.** Every environment runs SQLite — the device's, sql.js on the web, sql.js in tests — so a store
  writes each query once, in SQL, and a test runs the SQL a device runs. A store whose database file keeps failing
  moves to an in-memory database on the same engine, so a disk error costs persistence, not speed.
- **Dev-only guards.** Reading a store during render without subscribing is correct on first paint and frozen
  after, which is invisible on screen — so in `__DEV__` it warns, naming the partition and the component. Other
  guards catch a store bound too late, a memo sized too small, and a read fanning out across a list.

## API

Everything below is exported from the package root.

### Declaring a store

| export | what it gives you |
| --- | --- |
| `defineSqliteStore(config)` | the store, from its `schema`, `partition`, an optional `fetch` and `push`, and `build`: `reads`, `lifecycle`, and `push` for a store that declares one, on whichever connection is running, `capabilities` for what the store builds from that connection (a ranker running its own SQL, say), `bindSqlite` to run it on a connection, and `testing.over(conn)` for a test's own surface and the table to seed it through |
| `build`'s `cellar` | the read and cache constructors (`defineRead`, `defineReadAcross`, `defineCaches`), a partition's `rows(key, filter?)`, the partition primitives (`keyOf`, `partitionOf`, `keys`, `has`, `versionOf`, `bump`, `clearEtag`, `where`), and the `table` and `caps` for a store's own SQL |
| `defineShredColumns<Src, Ctx>()(columns)` | one column table bound to everything derived from it: `names`, `columnDefs`, `row`, `decode`, and `ops` once every column declares one |

### Rows

| export | what it gives you |
| --- | --- |
| `createSqliteRowTable` | the `RowTable` over any SQLite connection; `{ temporary: true }` builds it in the connection's temp schema |
| `RowTable` | `init`, three writes (`upsert`, `overwrite`, `shred`) that each return the entities they changed, reads (`getOne`, `find`, `findIn`, `has`, `entityIdsWhere`), the ETag pair (`getMeta`, `setMeta`) and each partition's stored description (`getMetaRecord`) |
| `ChangeSet`, `ALL_ENTITIES`, `NO_CHANGES` | what a write reports: the entities it changed, every entity when it cannot say, or none |
| `readRows`, `readRowsIn`, `pinnedReader` | reads over a connection (`readRowsIn` splits an `IN (…)` over a long list into as many statements as SQLite's bind limit needs), and the opt-out that pins one to a single handle |

The three writes differ in what they delete. `upsert` merges by primary key and removes nothing, which is what a
socket delta wants, so its rows carry their own `partition_key`. `overwrite(where, rows)` makes the partition matching
`where` be exactly `rows`, filling in each row's `partition_key`. `shred` is that same replacement from an undecoded
response body.

In a store's table, a write states only the columns a row has: a column a row leaves `undefined`, or a body leaves
out, keeps the stored row's value, and an explicit `null` clears it. A list endpoint that sends a subset of a detail
endpoint's fields, or a body without a nested block another body includes, never erases what the other stored.

Each column is one of three kinds:

| The column is | Declared | When a body leaves it out |
| --- | --- | --- |
| a fact about the row, which every partition holding it shares | nothing | the stored value stays |
| a field of a sparse object, whose missing keys mean unset (a stats map that leaves out zeros) | the op's `complete: '<object>'` | null, while the object is there |
| a field one fetch owns and the others never send, whose value changes, or one that depends on the partition | the schema's `perPartition` | the partition's own value stays; other partitions keep theirs |

`columnsLeftOut` (in `/testing`) lists every column one fetch states for a row and another leaves out for the same row,
from the rows each fetch builds out of a recorded body. A store's test holds the list to the columns it keeps on
purpose, so a new fetch or column fails it until someone decides which kind the column is.

On SQLite each write lands its rows in a staging table, and one transaction compares them with the table (every
column, null-safe) and replaces the rows of each changed entity. A partition that holds nothing yet skips the stage:
with nothing to compare against, its rows go straight in and every entity counts as new.

### Getting rows in

| export | what it gives you |
| --- | --- |
| a store's `fetch` | `(partition) => PartitionFetch`: the request as `query`, whose `queryFn` Cellar calls with the partition's stored ETag, its `toRows`, and optionally the `native` shred spec for it and the columns it `fills`; leave it off for a store fed only by pushes |
| a store's `push` | `idOf`, `toRows(key, items, partition)` and `partitionsOf`, for rows arriving by socket, which `store.push.ingest(items)` takes: an item the store's functions throw on dropped and reported, each other item written to the partitions its `partitionsOf` names that hold rows, or all of them when none does, buffered per partition, deduped, written in bounded chunks off the render path, held while their partition is being fetched, and retiring its ETag at most once every two minutes, so a refetch brings what the socket missed |
| `ShredSpec`, `ShredOp` | the native shred language, for filling columns without decoding in JS. A store's `nativeShredSpecs` name its specs; a partition fetch's `native` picks one and gives its binds, from 1, since Cellar binds the partition's key as 0 |
### Reading

| export | what it gives you |
| --- | --- |
| `cellar.defineRead()`, `cellar.defineReadAcross()` | a `{ getValue, useValue }` pair per read: one partition, or a set of them its `partitions` names. A read declares none of its args: it waits until every arg its caller passed has a value, fetching nothing meanwhile, and runs `select` again when they change. `optionalArgs` names the few it may be handed without one. An arg that is an object or an array keys by its content, and its identity is remembered per reference so a caller holding one across a list serializes it once. That is only sound while the content holds still, so `__DEV__` checks it on every reuse and warns when it changed, rather than freezing an object its owner may still mutate |
| `read.useEach(args)` | on a `defineReadAcross` read whose value is a list with one entry per partition: one `DataResult` per partition, each `loading` until its own partition lands |
| `withRead(useRead, { prop, useParams })` | a read's value handed to a class or `connect` component as a prop |
| `createCoverage(name)` | a list that already read its rows' values hands them to the rows below it, and a row reads its own only when the list doesn't cover it |
| `pairRead(read)` | publishes a read's two halves on a service. A caller passes every arg the read's args type requires, each as a value it may not have yet. They return the same value but do not fetch alike: `useValue` refetches on React Query's staleness, `getValue` fetches a partition that has never been fetched and otherwise leaves it |
| `rowsOf(table)` | a query, then a shape: `.rows`, `.map`, `.indexed`, `.grouped`, and `.ordered` for results parallel to the ids asked for — each returning the caller's stable empty |
| `createWindowedList(...)` | windowed list reads: fetch a page, keep the rest in SQLite |
| `DataResult<T>`, `makeResult` | the envelope a read hands back, and the builder for a bespoke read the surface can't express |

### Reactivity

| export | what it gives you |
| --- | --- |
| `runTracked` | the tracking scope an imperative read runs inside |
| `createTrackedSelector` | store-aware reselect, for reads reached from a Redux selector |
| `useTrackedValue` | the hook every reactive read goes through: runs a derivation, subscribes to exactly what it read, and honours the read gate — for a derivation over several stores, or over Redux as well |

### Caching derived values

| export | what it gives you |
| --- | --- |
| `cellar.defineCaches({ … })` | every value a store keeps on the heap beyond its rows, declared in one reviewable block, each entry named by its key and kept per partition for you. Nothing in it fetches: a value is built from rows already in the table, on first use |
| `byEntity` | one value per entity, built from that entity's rows and its partition's description by `fromRows(rows, partition)` (usually a view model), so a value carrying its partition's fields needs no column for them, and rebuilt only when a write changes them, handing back the previous reference for every other entity. Read by partition key and entity id: `.at`, `.atEach`, `.pick` depend on the entities they name alone; `.where` and `.all` on the partition, since which entities match can move. Every answer is cached, lists included: asked again, a method hands back the same array or object while what it holds is unchanged, and `.where` and `.all` run their query once per change to the partition. Every miss in one `.atEach` or `.pick` is built from one query. Name it after what it holds and its entity, such as `cardsByPlayer`; reads of the same shape share it, so an entity's value is built once however many ask |
| `byPartition` | values computed from the whole partition, and from any key parts it declares, dropped by every write that changed the partition; the lookup passes the build: `.for(key).read(() => …)`. It is where a read's expensive result lives, such as a ranking or a query's rows, since a read caches nothing itself |
| `shallowEqualValue`, `shallowEqualRecord`, `shallowEqualArray`, `shallowEqualStruct` | the `isEqual` family a read compares its value with |

### Host services and diagnostics

| export | what it gives you |
| --- | --- |
| `configureCellar(services)` | where an error report goes, and the React Query runtime an ingest mounts on |
| `reactQueryRuntime({ client, useQuery, useQueries })` | an app's React Query v4 client and hooks as that runtime, typed without casts at the call site |
| `createBoundedLru(max)` | the LRU map every cache here keeps its entries in, for an app's own bounded memo |
| `reportStoreDegradation`, `createOnceGuard` | how Cellar reports a silent slowdown, and warn-once guards a test can reset |

## Entry points

| entry | holds |
| --- | --- |
| `@sleeperhq/react-native-cellar` | everything above: what a store, a service or a screen writes against |
| `…/nitro` | `openNitroConnection`, `bindSqliteStore` and `retrySqliteStores`, over `react-native-nitro-sqlite` — the only part that touches native code — and `dumpSqliteStores`, which copies every store's database into one file for a desktop SQLite browser |
| `…/sqljs` | `bindSqlJsStore` and `openSqlJsConnection`, over a sql.js module the app loads — what the web runs on |
| `…/testing` | sql.js off-device (`createTestRowTable`, `createSqlJsConnection`), an in-process version atom, the host services as spies, and the internals only a test reaches for |
| `…/diagnostics` | `getIngestTimings` and `rollupIngestTimings`, for a developer surface; no shipping screen reads these |
| `…/inspector` | every declared store (`inspectedStores`) with its schema, where it runs, its partitions and the entities they changed lately, one entity (an id within a partition) with its rows and cache entries, its caches with their hits, misses, evictions, estimated heap and entries, and read-only SQL over its database a page at a time; and a log of what the stores did — writes, moves between databases, fetches, degradation reports with their numbers and callsite — with a listener for each new event (`onInspectorEvent`). What the DevTools plugin reads; the log is recorded in development builds only |
| `…/redux` | `createReduxBridge(useStore)`: `useTrackedStores` and `withTrackedStores`, derivations over a Redux store and the Cellar stores together, which re-run on a dispatch that replaced the state or a write to what they read. Handed the app's `useStore`, so Cellar depends on neither Redux nor its React binding |

The lint rules that go with these ship as [`@sleeperhq/eslint-plugin-cellar`](eslint-plugin/README.md), and a
React Native DevTools panel for watching the stores live as [`@sleeperhq/rozenite-plugin-cellar`](rozenite-plugin/README.md).

The core entry runs anywhere React does. Each subpath is declared twice — in `exports`, and as a stub
`package.json` beside `lib/` — because TypeScript and Metro still resolve the way Node did before `exports`
existed.

**Releasing.** Bump `version` in `package.json`, then run `npx gitpkg publish`. It builds `lib/` (`prepublishOnly`),
packs the package's `files` and pushes them as the `react-native-cellar-v<version>-gitpkg` tag, so `lib/` is never
committed. The plugins in `rozenite-plugin/` and `eslint-plugin/` release the same way, from their own directories.

## Internals

[`docs/internals.md`](docs/internals.md) is the long form: every export in detail, the rules each one imposes,
the two schema fingerprints and how they decide between widening and rebuilding, what the push buffer does and
why each property of it is load-bearing, and a map of every file in `src/`. Read it when you need to know why a
piece behaves the way it does, or when you are changing Cellar itself.

## License

MIT © Blitz Studios, Inc. See [`LICENSE`](./LICENSE).
