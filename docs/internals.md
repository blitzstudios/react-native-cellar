# Internals

The long-form reference behind [the README](../README.md): every piece Cellar exports, the rules it imposes,
and why each one is shaped the way it is. The README is enough to write a store; this is what to read when you
need to know *why* a piece behaves as it does, or when you are changing Cellar itself.

---

## What Cellar gives you (the reusable half)

Everything in this package is shared and already tested. You compose these; you don't reimplement them.

A note on reach: `index.ts` exports what a store, a service or a screen writes against. The pieces
`defineSqliteStore` is itself built out of — `definePartitions`, the read surface, the fetch ingest, the SQL batch and
migration helpers — are described below but deliberately absent from it. Wanting one of them by name usually means a
store is reaching past its entry point; import it from its own module only if you are working on Cellar itself.

- **`defineSqliteStore`** — a store's whole spine in one descriptor: its table, its partitions, its fetch and its
  reads, over the version atom, the one slot holding the functions built over the running connection, the unbound
  default every read answers `empty` from, and the recovery path when a statement fails mid-session.
- **`createRowTable` (`createSqliteRowTable` / `createMemoryRowTable`)** — the row engine from a
  schema: `find` / `findIn` (indexed slice reads), `has`, `getMeta` / `setMeta` (ETags), and three writes.
  SQLite on mobile, in-memory on web/test — same interface.

  **The three writes.** `upsert(rows)` merges by primary key and removes nothing, chunked off-thread — what a
  socket delta wants. `overwrite(where, rows)` makes the slice matching `where` be exactly `rows`, deleting first
  in one transaction. `shred(where, rawJson, parse)` is that same replacement from an undecoded body, shredded in
  C++ so the payload never becomes a JS object graph; with `inJs` it parses with `parse` instead, still in the table's
  write queue. Only `overwrite` and `shred` name a slice, because only they delete; and in DEV every row they write is
  checked against the filter it was written under.

  **Changing a schema.** Edit the schema and ship it; there is no migration to write. `init` stamps a fingerprint
  of everything it builds — columns, primary key, indexes, the ETag side-table, the shred spec — into
  `PRAGMA user_version`, and a database whose stamp doesn't match is migrated on the spot. There are two ways that
  can go, and which one you get is worth knowing before you edit:

  - **A widening**, where the declaration only *added* columns. The table is kept and each new column arrives by
    `ALTER TABLE ADD COLUMN`, so not one row is lost. This is the case worth having: a schema whose columns are
    generated from a catalog — the metric keys a category publishes — gains a column every time the catalog does, and
    dropping a user's whole table to add one costs them a refetch for nothing. The added columns are `NULL` in every
    row that predates them, so the ETags go even though the rows stay: keeping one would answer the fetch that fills
    them with a 304.
  - **A rebuild**, for everything else — a changed key, a changed index, a renamed ETag table, a shred op that now
    fills a column it already had from a different path. Each of those restates rows already on disk, and no
    `ALTER TABLE` can restate them, so the table is dropped and refilled from the next fetch. A half-migrated table
    fails silently instead (a stale primary key turns ingest's `INSERT OR REPLACE` back into `INSERT`).

  Telling those apart takes two stamps, because a fingerprint that no longer matches can't say *what* moved:
  `PRAGMA user_version` holds the whole declaration's, and `PRAGMA application_id` holds the same hash with the
  columns left out — the table's, and the shred spec's `columns`/`ops` with them, since a spec is index-aligned with
  the table and a generated column arrives together with the op that fills it. Structure stamp equal and columns only
  added ⇒ widen; anything else ⇒ rebuild. A database built before the second stamp existed reads it as `0`, so its
  next schema change is one last rebuild, and every widening after that is free. The stamps are also what make an
  index edit take effect at all: `CREATE INDEX IF NOT EXISTS` is a no-op against an index of the same name over
  different columns, and `PRAGMA table_info` doesn't report indexes. Two fields on the schema go with them:

  - `pushFed: true` — for a store fed by socket as well as fetch. A rebuild there loses whatever arrived by push
    since the last fetch, so one files a sampled `info` notice naming the table. It does **not** throw, in `__DEV__`
    or anywhere else: `init` stamps the schema last, so refusing the rebuild would leave the stale stamp on disk and
    bind the in-memory backend on every launch after — permanently slower than the heap it replaced, over a change
    someone shipped on purpose. Catch the edit where the edit happens, by pinning the store's column set in a test.
  - `rebuildVersion` — bump to force a rebuild for something the stamps can't see, and it is part of the structure
    stamp, so bumping it is never mistaken for a widening. Two things need it. One is a row builder written in JS
    with no shred spec beside it: a change there leaves rows stale rather than malformed, and the stored ETag will
    304 the correction away. The other is repointing a shred op on a column that already exists *in the same release
    that adds a column* — alone that rebuilds (a plan with nothing to add is a rebuild), but alongside an addition it
    reads as a widening and the old values under the repointed column stay. Bumping this drops the ETags with the
    rows, which makes the next fetch a real one.

  **The shred specs are part of the fingerprint, which is why a store declares them as a map, `nativeShredSpecs`,
  keyed by variant.** The fingerprint has to hash every spec a store can shred through, so the specs have to be
  enumerable. If your spec varies — different columns per category, say — enumerate the variants, and have each
  fetch plan's `native` name one. Naming a variant that isn't in the map falls back to the JS parse path rather than
  shredding through `undefined`.
- **Partitions** — **how a store's rows are divided into partitions it can fetch.** A store answers one question —
  *which args describe one partition?* — and Cellar derives the rest of the plumbing from the answer:

  ```ts
  const myStore = defineSqliteStore({
    name: 'my_store',
    schema: mySchema,
    partition: ({ groupId, itemType }: Loose<MyGroup>) => (groupId && itemType ? { groupId, itemType } : null),
    fetch: (group: MyGroup, etag?: string) => ({
      query: buildMyRawQuery(group, etag),
      toRows: (rawJson) => buildMyRows(group, JSON.parse(rawJson)),
    }),
    build: (cellar) => ({ reads: { … } }),
  });
  ```

  The partition's **description** (`{ groupId, itemType }`) is what a fetch is made from: `fetch` is handed it, and
  answers with everything about that request. Its **key** is the string Cellar identifies it by, derived from the
  description by `partitionKeyOf`: each field `name=value`, in name order, joined with `&` (`groupId=g1&itemType=regular`),
  names and values escaped, a list's values joined with `,`, and a field left `undefined` the same as one left out. Keys name partitions, and ids name entities.

  The key locates the partition for every operation Cellar runs on the store's behalf. A row is stored once, by its
  primary key, which is its identity across every partition, so a store without one is refused; each partition keeps
  the rows its fetch returned in a membership table, and the table a store reads by name is a view joining the two,
  with `partition_key` as its first column. A replace (`overwrite`, `shred`) fills in each staged row's
  `partition_key` from its `where`, so a store's `toRows` never builds it; the native shred gets it as bind 0, so a
  store's programs bind their own values from 1. `upsert` fills nothing in, so a push's rows carry their own. The ETag side table (`<table>_meta`) is keyed by it too, and keeps each partition's description as
  JSON beside the ETag — written the first time the partition's version is bumped, kept when its ETag is cleared.

  `partition` turns a read's args into the description of the partition the read reads — `{ groupId }` from
  `{ groupId, itemId }`, a sport that shares another sport's players, a locator a screen is still filling in. It
  answers `null` for args that name no partition yet, and such a read is off, primes nothing, and returns its `empty`. Cellar keeps each description for the most recent `internMax` keys (512 by default), so a fetch
  gets the description back from the key; one past that is read back from the side table. A store whose
  `partition` hands back the same object for the same args has its key derived once, through a `WeakMap`; in dev
  that object is frozen, since a memoized key is only sound while the description holds still.

  `fetch` is the store's real fetch behaviour and nothing else: the request, and how a body becomes rows.
  Everything mechanical around it belongs here — trying the native shred, falling back to a JS parse and
  reporting the degradation when it can't run, holding the ETag, recording when rows landed, bumping, and holding the
  partition's pushes while it is in flight. A plan names its native program, or leaves it out for a body the native
  pass can't iterate, and names the columns it `fills` when it fills only some. Leave `fetch` off entirely for a
  push-fed store.

  `push` sits beside it, for rows that arrive by socket: `idOf`, `toRows` and `partitionsOf`, and nothing about how
  they are written. `toRows` is handed the partition's description, so an item needn't carry what every row in the
  partition shares. A store that declares it gets `store.push.ingest(items)`, which drops and reports an item the
  store's own functions throw on rather than the whole batch; one that doesn't declare it has no `push`.

  `build` gets one argument, `cellar`: the read and cache constructors (`defineRead`, `defineReadAcross`, `defineCaches`), a
  partition's rows (`rows(key, filter?)`), the primitives a store's own SQL needs (`keyOf`, `partitionOf`, `keys`,
  `has`, `versionOf`, `bump`, `clearEtag`, `where`, `table`) and the connection's `caps`. It returns `reads`, and
  lifecycle functions of its own where it has them. Every store's **`lifecycle`** comes from Cellar —
  `usePrime`, `usePrimeMany`, `usePrimeAndVersion`, `has`, `getVersion`, `getFetchedAt`, `fetch`, `refetch`,
  `invalidate`, `forget` — with the store's own functions added. Every member takes the same **args** a read does, in
  the `(args, options?)` call shape a service publishes. `usePrime` and `usePrimeAndVersion` take those args loosely,
  so a screen calls them with what it has, exactly as it calls a read: a field that has not arrived names no
  partition, so neither primes anything.

  Underneath, `definePartitions` is the engine all of this is declared through: the key, the interning, the fetch
  ingest and the read surface over one row table, built once per connection.
- **`createFetchIngest`** — the fetch engine `definePartitions` composes: React Query orchestrates a raw-text fetch
  (ETag-conditional), `ingestRaw` shreds it into the row table, the version bumps. Gives you `usePrime` /
  `usePrimeMany` (reactive, one partition or a variable set) and `ensure` (imperative self-heal). Generic over
  your key, with `toParts` the one place it is spelled positionally. You should not need to call this directly.
- **`createPushIngest`** — the same job for rows that arrive by socket rather than by fetch. Pushes come in far
  faster than they need to be persisted, one item at a time rather than one partition, and they can land on a
  partition a fetch is midway through deleting and rewriting — so this buffers per partition, dedupes by
  `idOf`, writes in bounded chunks off the render path, requeues a failed chunk without overwriting anything
  newer, and **holds** a partition for the length of a fetch. Cellar creates one per connection from a store's `push`
  (`idOf`, `toRows`, and `partitionsOf`, the partitions an item may belong to), supplies the table, the partition's
  rows and the bumps, holds the partition's pushes whenever it is fetched, and retires its ETag at most once every two
  minutes after a push writes to it, so a refetch brings a full body without every refetch during a live stream being
  one. The store gets `push.ingest`, which writes each item to the partitions its `partitionsOf` names that hold rows,
  or to all of them when none does, since a push can be a partition's only source. What it does inside, and why each part of
  it is load-bearing, is [below](#the-buffered-flush-behind-createpushingest).
- **`rowsOf(table)`** (`row_shaping.ts`) — a hydration's whole read side: ask it for rows, then say what shape you
  want them in. `rows.where(filter, opts)` and `rows.in(filter, column, values)` are the two queries, `.given(rows)`
  wraps rows you already hold, and each hands back something with `.rows`, `.map(fn, empty)`, `.indexed(column)`,
  `.grouped(column)` and — for `.in` — `.ordered(mapper, empty)`. Every shape returns the caller's **stable empty**
  when nothing survives. `ordered` is for an index-parallel result: SQL `IN` does not preserve argument order and
  `findIn` chunks on top of that, so a caller treating rows as parallel to the ids it asked for needs them reordered
  — which is why it hangs off `.in` alone and cannot be reached from a query that has no ids.
- **`partitionLabel(parts)`** (`args_key.ts`) — a partition's parts joined on `:` for a log line or a telemetry
  field. Never a key: `:` occurs inside a part (`region:us-west`), which is why keys don't use it. Keys themselves
  are not the caller's to build — a read's is the engine's, and a memo's comes from the partition it is bound to.
- **`chunkList` / `getOrCreate`** (`collections.ts`) — bounded batches, and the `Map` entry that may not exist
  yet.
- **`createVersionAtom`** — per-partition integer reactivity (a module-level `useSyncExternalStore`). `bump`
  on write; `useVersion` to subscribe; `useSelect` to subscribe + read a value with a bail-out; `get` for
  imperative reads.
- **`createReadSurface`** — **the read engine, reached through a store's `defineRead` / `defineReadAcross`.** A read is
  one identical five-part shape — locate the partition, prime it, subscribe its version, select a bounded
  subset, wrap in an envelope. You declare it once as a `read<Args, Value>({ partition, select, empty })`
  descriptor, and the engine generates both halves: `read.getValue` (imperative, self-priming, reference-stable) and
  `read.useValue` (reactive `DataResult<T>`; named `useValue` so React Compiler treats it as a normal hook,
  not React's `use()` API). Your
  only job is `select(args, key)` — the SQL subset → VM — everything mechanical is the engine, including skipping
  `select` entirely while the partition is still empty. A store's read surface becomes a small table of
  `read` descriptors.

  `defineRead` reads the partition the store's `partition` spec names from the args, so a read declares no partition
  at all, which is the common case. Give `partition` explicitly only for an address one read computes differently
  from its siblings. `defineReadAcross` always names its own `partitions`, since the set is the read's.

  A read declares none of its args. It is ready once every arg its caller passed has a value — `undefined`, `null`,
  `''` and an empty list count as none, `0` and `false` are values — and until then it fetches nothing and runs
  nothing: one gate, for the fetch and the read alike. `optionalArgs` names the few a read may be handed without a
  value, such as a filter its `select` applies only when there is one; they are its third type argument too,
  `read<Args, Value, 'position'>`, which is what types them. The read's own functions — `select`, a `partition`
  function, `enabled` — see the args through a view (`args_view.ts`), one per read and reused across calls: every
  arg arrives non-null, and reading one the caller left out entirely stops the function and returns `empty`, with a
  dev warning naming the arg. The store's key reads them as passed, since it is shared by reads that take different
  args and answers a missing value with no partition. The view costs a trap per arg read, a fraction of a
  microsecond a call.

  A read caches nothing itself. A hook runs `select` again when its args change, compared field by field and by
  content, or when what it read changes, and keeps its last object while the new value is equal; `getValue` runs
  `select` on every call. So `select` returns values out of the store's caches, and whatever it builds that costs
  anything, it builds inside one. In dev, a read whose `select` builds the same value from rows no cache holds three
  times over, for the same args and the same rows, is warned about by name.

  Two variations cover the rest: `defineReadAcross({ partitions, … })` for a read spanning a variable set of
  partitions (it observes the same fetches through `usePrimeMany`, so it reports loading like any other read), which
  is also how a read answers several lookups at once, each with its own candidate partitions — `partitions` names them
  all, and `select` finds each lookup's own from its args; and, for a push-fed table, leaving `fetch` off, so its
  reads report `success` over an empty value. Cellar takes the fetch half as one value: the priming hooks and the refetch that goes
  with them are supplied together or not at all.
- **`defineCaches`** — every value a store keeps on the heap beyond its rows, in one block, and the only way it caches
  one:

  ```ts
  const { gamesByTeam, summaryMap } = defineCaches({
    gamesByTeam: byEntity({ max: 2048, fromRows: rowsToTeamGames }),
    summaryMap: byPartition<MySummaryMap>({ max: 2048 }),
  });

  gamesByTeam.at(key, team);
  summaryMap.for(key).read(() => deriveSummaryMap(rows(key).rows));
  ```

  The block is reached off the store's partitions, which is what makes both kinds possible: a cache takes the
  partition's key parts, its version and each entity's version from there, so **no store builds a cache key or looks up
  a version**. What a store still names is `max`, which bounds what it keeps on the heap, and, for `byPartition`, its
  key parts, the second type argument: what the key holds beyond the partition, one argument to `.for(…)`'s methods per
  part, in order, each either a scalar or a structured value Cellar interns. So the block stays a complete, reviewable
  account of the store's heap. Each cache carries a dev-time watch that reports itself too small for the keys it keeps
  being asked for again, and reports itself if it has never once answered from its entry; the report names it by its
  key. A module that declares its own caches, such as a ranker, takes the store's `defineCaches` function as a
  `CacheFactory`, and a suite testing that module alone builds one with `testCache` from `./testing`, which takes
  `byPartition` caches only.
- **`byEntity`** — one value per entity, built from that entity's rows by `fromRows`, which is also handed the
  partition's description so a value carrying its partition's fields needs no column for them, and kept until a write
  changes them. A lookup (`at`, `atEach`, `pick`) depends on the entities it names, so a write to other entities neither
  rebuilds their values nor re-runs the read; `where` and `all` depend on the partition. Every miss in one `atEach` or
  `pick` is built from one query, and a read asking for more entities than `max` builds its values without keeping them,
  so it evicts nothing a smaller read holds, and depends on the whole partition instead. Underneath, the values sit in
  an entity memo (`entityMemo` in `caches.ts`), keyed by entity and, where a filter can cut an entity's rows, by the
  filter. Its lists are cached too, in a bounded map of the last 64 it answered: each method hands back the list it gave
  last time for the same ids or filter when that list holds the same values, and `where` and `all` keep which entities
  matched until the partition's version moves, so a repeat runs no query.
- **`byPartition`** — a cache dropped by every write to its partition, with optional content-stable reference reuse: on
  a bump that didn't change an entry, hand back the _same reference_ so downstream shallow-equal bails.
  `read(…parts, compute)` is the whole cache in one call; `peek`/`set` are its batched half, for a caller that
  gathers its misses and computes them in one round-trip.

  Reach for it for whatever a `select` builds that is expensive and asked for again: a value **several reads** derive
  from a partition's rows, one **a read consults per item**, or **one read's own result** when building it runs a
  query or a ranking. A read keeps nothing between calls, so without one, every subscriber and every `getValue` call
  builds it again. What a `select` assembles cheaply out of cached values, such as a map over a `byEntity` list, needs
  no cache of its own.
- **`readStatus`** — the loading-status rule (`loading` while a cold fetch is in flight, else `success`).
  The engine calls this for you; bespoke batch reads call it directly.
- **`shallowEqualValue`, `shallowEqualRecord`, `shallowEqualArray`, `shallowEqualStruct`** — the `isEqual` family. A
  read that names none gets `shallowEqualValue`, which is one level the way a store would have written it by hand: a
  list by its elements, a record by its values, anything else by identity — so a hydration rebuilding a list or a map
  out of unchanged parts bails its readers out without being asked to. Name one only where a level is not enough,
  which in practice means `shallowEqualStruct` for a struct: it takes a check per field for the fields holding a
  record or a list and compares the rest with `Object.is`, so a scalar field added later is covered without touching
  the call. `shallowEqualRecord` and `shallowEqualArray` are the two it composes, for a memo handing one over.

**Declare reads through the engine; no store here hand-writes one.** If you ever need to, two rules apply:
every imperative getter must call `version.get(parts)` on **every** call, cache hit included, or its reads
become invisible to both the tracking scope and the DEV guard below; and if the hook reads during render while
subscribing itself, wrap the read in **`runSubscribed(() => …)`** so the guard knows the subscription exists.
`createReadSurface` and `useSelect`/`useSelectMany` already do both for you.

**The guard:** in `__DEV__`, a read that happens during render with nothing subscribing it logs a warning naming the
partition and the component (`reactivity/tracking.ts` + `reactivity/render_phase.ts`). That failure is invisible on
screen — the value is correct on first paint and then frozen — so it is checked at the single choke point every read
passes through. Reads outside render (callbacks, reducers, socket handlers) are deliberately unsubscribed and stay
silent.

---

## What a store's `build` returns: `{ reads, push?, lifecycle? }`

Three groups, and which one a new function belongs in is decided by who calls it, not by what it does:

| group | holds |
| --- | --- |
| `reads` | one `defineRead` / `defineReadAcross` read per name. Required — a store with nothing to read is not a store. |
| `push` | a caller handing rows **in** |
| `lifecycle` | the store's own partition-level operations beyond the ones Cellar gives every store (priming, freshness, invalidation), such as a developer surface's sample |

**A fetch-fed store's ingest belongs to the partition's `fetch`, and the only way rows arrive is a fetch the read
surface already triggers — the common case.** You add `push` when rows arrive from
somewhere Cellar doesn't own (a socket). `lifecycle` is where a caller outside the read path primes, checks
freshness or invalidates a partition.

A group with no members is left off rather than declared empty, so a store's shape tells you what kind of store
it is at a glance. `StoreSurface` requires `reads`, and a store-shape guard test in the consuming app
fails on a fourth group name, which keeps the grouping exhaustive enough to rely on when reading an unfamiliar
store.

---

---

## The facade

The service facade publishes reads; it does not re-implement them. `pairRead` takes the read and returns both
halves, with params typed as `Loose<Args>`: every field the args type requires, each as a value the caller may
not have yet.

```ts
const Reads = {
  GroupItems: pairRead(() => myStore.reads.GroupItems),
};

export const Hooks = { useGroupItems: Reads.GroupItems.useValue };
export const Get = { getGroupItems: Reads.GroupItems.getValue };
```

The read supplies its own gate, so the pair adds none: it hands the params over as they are, and the read waits
until each has a value. `Loose<Args>` keeps every field the args type requires, so a caller that leaves one out
fails to compile rather than fetching a partition for a read that cannot run; passing it as `null` is how a caller
says it doesn't know it yet.

A facade read's params are the store read's own args, so a service names no vocabulary of its own and translates
nothing: `pairRead` takes the read and nothing else.

Both halves resolve the store's running reads per call, so the SQLite bind at startup is picked up by callers that ran before
it. Publishing only one half is what pushes a Redux selector into a loop of point reads, so a read-pairing guard
test in the consuming app fails on a read that ships without its twin.

---

## Declaring the store itself

The wiring is one descriptor: `defineSqliteStore` folds the version atom, the slot holding the running functions,
the unbound default and the recovery path in with the store's table, partitions and reads:

```ts
export const myStore = defineSqliteStore({
  name: 'my_store',
  schema: mySchema,
  partition: ({ groupId }: Loose<ItemKey>) => (groupId ? { groupId } : null),
  fetch: myFetch,
  build: buildMyReads, // (cellar) => ({ reads, push?, lifecycle? })
});
```

…and mobile binds it in one line, from wherever the app runs its startup:

```ts
export const initMyStore = () => bindSqliteStore('initMyStore', 'my.db', myStore);
```

Caching, reactivity and fetch orchestration are Cellar's; a store does not write its own.

Two optional fields beyond those: `nativeShredSpecs` for a native (simdjson) ingest shred, and `capabilities` for an
accelerator that needs the live connection. Until a bind, a store runs over a connection that answers nothing, so
every read returns its `empty`; that default is built on first read, so a platform that binds first never
constructs one at all.

---

## The buffered flush behind `createPushIngest`

Two rules for the shape of a push-fed store first. A store fed *only* by a socket leaves its
`fetch` off, so its reads report `success` over an empty value, and sets `pushFed: true` on the schema, so a
rebuild of a table no fetch can refill says so out loud. A store fed by *both* has one decision to make
explicitly: what a frame naming a partition nothing has fetched should do. Creating the partition is what lets
rows appear for an entity no screen asked the API for — the only way they can appear at all, when the socket is
their only source; dropping the frame means they never do.

A bulk completion carries thousands of rows at once, and writing them inline froze JS for ~2s. So `ingest` never
writes: it stages rows and returns, and a scheduled task does the work. Five properties carry that, and each one
is load-bearing:

- **Stage into a `Map` keyed by row identity.** Two frames touching the same row inside one flush window collapse
  to the last, which is what makes a burst cost one write per *row* rather than one per *frame*.
- **Flush on a macrotask, chunked, yielding between chunks.** `setTimeout(0)` gets it off the current frame;
  `upsert` in chunks of 250 with a yield between them keeps a long flush from becoming the same block in a
  different place. Reactivity lands a frame after the write resolves, which is the deliberate trade.
- **Bump every touched partition once, inside `notifyManager.batch`.** The flush collects the distinct partitions
  it wrote and bumps them together, so a thousand rows across four partitions is four bumps in one React commit.
- **On failure, requeue only what no newer write replaced** (`if (!pending.has(key))`) and retry after a delay.
  The guard is what keeps a retry from putting a superseded row back over a fresher one, which is the one
  failure in here that reaches the screen as wrong data rather than as jank.
- **Clear the partition's ETag on every socket write** (`onSocketWrite`). The ETag describes the last body the
  *fetch* ingested, not the socket's writes over it, and the rows outlive the process — so the next launch would
  304 and keep an entity frozen where the socket left it. Costs nothing while the entity is live, since a body the
  socket is tracking is changing and would not have matched anyway.

---

## Map of the files here

**What earns a place in this package:** Cellar is the store-authoring vocabulary — the pieces you compose to write a
store. Being generic is not the bar, and neither is having more than one caller: a mechanism belongs here when a *store
author* reaches for it. So `read/windowed_list.ts` lives here with a single consumer today, because "windowed list read"
is one of the read shapes you choose between when writing a store; whereas the compute-table LRU inside a native-compute
store's ranker is just as generic and stays in that store, because no store author picks it — it's how that one store's
ranked scan happens to work. A per-store mechanism moves here when a second *store* needs it, which is also the point at
which its shape has been checked against more than one caller.

Cellar's reusable core (you use, never fork):

The root holds what a store declares itself with, plus the primitives every folder below needs. The folders
follow the trip a row takes: it lands in a `table/`, gets there through `write/`, comes back out through
`read/`, and the component that asked hears about it through `reactivity/`.

| file                                             | role                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `define_sqlite_store.ts`                         | the descriptor a store declares itself with (table, partitions, fetch, reads), and the spine it builds: version atom, running slot, recovery path |
| `define_partitions.ts`                           | the engine under it: one table's partitions, their keys, their fetch, and the lifecycle over them |
| `store_result.ts`                                | the `DataResult` envelope, and the `readStatus` rule that fills one     |
| `prime_state.ts`                                 | what a read knows about the fetch behind its partition — the contract between the two, so neither imports the other |
| `key.ts`                                         | how a key's parts are joined, on a separator no part can contain; imports nothing, so anything may have it |
| `args_key.ts`                                    | what a read's key is derived from: a value by its content, a partition, a vary list |
| `caches.ts`                                      | bounded LRU, the `byPartition` cache and the entity memo under `byEntity`, and the `isEqual` family |
| `cache_block.ts`                                 | the `defineCaches` block: binds each `byEntity` and `byPartition` entry to a store's partitions |
| `collections.ts`                                 | `chunkList` and `getOrCreate`                                             |
| `runtime.ts`                                     | the host's three services — where a report goes, the query runtime an ingest mounts on, and when a read is live — and the inert defaults until one is installed |

| `table/` — where rows live                       |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `types.ts`                                       | the schema types and the `RowTable` contract                              |
| `sqlite.ts`                                      | the `RowTable` over any SQLite connection; `query.ts` holds the `where`/order semantics it answers with |
| `partitioned.ts`                                 | the `partition_key` column Cellar adds to a store's schema, and the native shred specs extended to fill it |
| `schema.ts`                                      | what `init` builds, and the two stamps that decide between widening it and rebuilding it |
| `presence.ts`                              | whether a row filter holds rows, cached — a read asks far more often than it changes |
| `connection.ts`                                  | batch/read helpers over the native binding; routes reads to the reader handle (`pinnedReader` opts out, for `TEMP`-table readers) |

| `write/` — how rows get in                       |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `fetch_ingest.ts`                                | write-through fetch → shred → bump                                       |
| `push_ingest.ts`                                 | the push counterpart: buffer → dedupe → chunked write → bump, with per-partition holds for an in-flight fetch |
| `shred_columns.ts`                               | co-located shred column table (each column's `sql` + its `js` twin), and `defineShredColumns`, which binds it to everything derived from it — `names`, `columnDefs`, `row`, `decode` (a stored row read back into JS values), and, once every column declares an `op`, `namedOps` and `ops` |
| `shred_spec.ts`                                  | the native shred op language + its JS reference interpreter              |

| `read/` — how rows come out                      |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `surface.ts`                                     | the read engine — `read({ … })` → `{ getValue, useValue }`               |
| `partition_fields.ts`                            | the field specs a read names its partition and its vary key with          |
| `row_shaping.ts`                                 | `rowsOf`: a query, then rows → list / ordered list / record / groups, each with the stable empty |
| `derived_values.ts`                              | `byEntity` caches: a value per entity, built from the entity's rows by `fromRows` (usually a view model), kept until a write changes that entity, so a bump rebuilds only the entities that moved and every other reader gets the same reference back |
| `facade.ts`                                      | what a service is written against: `pairRead`, so it exposes the hook and the imperative read together, plus the types its methods are spelled in (`ReadOptions`, `MaybeId`, `Loose`) |
| `windowed_list.ts`                               | windowed list reads (fetch a page, keep the rest in SQLite), and the per-row `useWindowedDetail` that indexes back into one |

| `reactivity/` — how a write reaches a component  |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `version_atom.ts`                                | per-partition reactivity, and the host read gate applied to a subscription: a dead gate drops the subscription and holds the version, so the read keeps its value by reference and catches up in one render |
| `tracked_selector.ts`, `tracking.ts`             | store-aware reselect, for reads reached from Redux selectors; also the DEV guard that catches an unsubscribed render read (`render_phase.ts` is its phase probe) |

| `diagnostics/` — how the layer reports on itself |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `telemetry.ts`                                   | reports silent perf degradation (a native fallback that stayed correct)  |
| `ingest_timing.ts`                               | per-ingest timings, rolled up for the dev overlay — the `./diagnostics` entry, which no shipping screen reads |
| `once_guard.ts`                                  | warn-once guards that a test can reset                                   |

| `inspector/` — what a development tool sees      |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `registry.ts`                                    | every declared store by name; `defineSqliteStore` registers each, and a re-declaration under the same name replaces it |
| `store.ts`                                       | one store as the tool sees it: schema, binding, partitions (rows, version, ETag, last fetch) and read-only SQL, all looked up on the running surface without counting as a read |
| `read_only.ts`                                   | what lets a typed query through: one statement, a reading verb, a pragma in its reading form, and a compiled program that opens no write transaction |
| `caches.ts`                                      | every declared cache with its hits, misses, evictions and builds, counted by the dev watch each cache carries |
| `events.ts`                                      | the bounded log of writes, binding moves, fetches and degradation reports (with their numbers, a count per scope and a callsite), with listeners; dev builds only |

| `nitro/` — the device                            |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `nitro_connection.ts`                            | the `SqliteConnection` over `react-native-nitro-sqlite`: pragmas, param coercion, the native shred sentinel, and the binds that degrade rather than throw |

Two more entries ship beside the core one. `./diagnostics` holds what a developer surface dumps —
`getIngestTimings` and `rollupIngestTimings` — kept out of the core entry because a shipping screen has no
business reading them. `./testing` is what a store's tests are written against: `sqljs_connection.ts` (a real
SQLite engine for parity tests), `version_atom.ts` (in-process version atom with working `subscribe`),
`runtime.ts` (the host services as spies), `caches.ts` (a store's `cache` block for a suite that builds one module
rather than a whole backend), and `dev_mode.ts` (the wrappers pinning a case to one build). It also re-exports the
handful of internals that only a test reaches for — a real `createVersionAtom` to bump by hand, `evalShredElement`
to check a native shred against, and `resetOnceGuards` — which is why those are absent from the core entry.

Bespoke per store, and staying in the app: the schema, the payload types, the row builders and the shred spec beside
them, the view models and the `fromRows` functions their derived values are declared with, and the backend that composes
all of the above out of the pieces here. A native-compute store adds the SQL engine behind its whole-collection read,
which is advanced, opt-in, and no part of this package.
