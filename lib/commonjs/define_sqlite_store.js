"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineSqliteStore = defineSqliteStore;
exports.partitionKeyOf = partitionKeyOf;
var _queryCore = require("@tanstack/query-core");
var _telemetry = require("./diagnostics/telemetry.js");
var _version_atom = require("./reactivity/version_atom.js");
var _connection = require("./table/connection.js");
var _once_guard = require("./diagnostics/once_guard.js");
var _sqlite = require("./table/sqlite.js");
var _partitioned = require("./table/partitioned.js");
var _define_partitions = require("./define_partitions.js");
var _surface = require("./read/surface.js");
var _row_shaping = require("./read/row_shaping.js");
var _push_ingest = require("./write/push_ingest.js");
var _etag_retirement = require("./write/etag_retirement.js");
var _events = require("./inspector/events.js");
var _registry = require("./inspector/registry.js");
var _store = require("./inspector/store.js");
var _change_set = require("./table/change_set.js");
/**
 * Declares a store: a SQLite table of rows, how rows arrive by fetch and by push, and the reads and lifecycle functions
 * built over it. A store runs
 * on SQLite everywhere (the device's SQLite on mobile, and sql.js, SQLite compiled to WebAssembly, on web and in
 * tests), and can move between databases during a session without its callers noticing.
 */

/**
 * Objects a store builds from its database connection besides its row table, such as a ranker that runs its own SQL
 * queries. They are rebuilt with the rest of the store whenever it moves to another connection, and passed to
 * {@linkcode SqliteStoreConfig.build | build} as {@linkcode CellarContext.caps | caps}.
 */

/**
 * What a store's {@linkcode SqliteStoreConfig.build | build} returns: its reads, and optionally lifecycle functions of
 * its own. Callers reach them through the store (`store.reads.x`), which always points at the ones built over the
 * database the store currently runs on.
 */

/**
 * The partition a read's args name, as its description: `{ sport: 'nfl' }` from `{ sport: 'nfl', playerId: '4046' }`.
 * Args beyond it pick rows within the partition; a read of another partition names it with its own `partition`.
 * Return `null` or `undefined` until the args are complete, and the read reads and fetches nothing until then. The
 * partition's key is its description serialized by {@linkcode partitionKeyOf}, so a list in it must be in one order.
 */

/**
 * A partition's {@linkcode PartitionFetch}, given its description. A fetch replaces the partition's rows with the
 * response's, and holds the partition's pushes while it is in flight.
 */

/**
 * How items pushed to a store from outside a fetch, such as a socket's, become rows: {@linkcode PushIngestConfig}, less
 * what Cellar supplies (the table, the partition's rows, and the version bumps). Each row must carry its partition's
 * `partition_key`. A push adds and updates rows and never deletes one. Cellar buffers the items, keeping the latest
 * per {@linkcode PushIngestConfig.idOf | idOf}, and writes them soon after and outside the current render.
 */

/** What Cellar gives a store that declares {@linkcode SqliteStoreConfig.push | push}, as {@linkcode SqliteStore.push | store.push}. */

/** A store's {@linkcode StorePush}, or `undefined` for a store that declares no {@linkcode SqliteStoreConfig.push | push}. */

/**
 * What a store's {@linkcode SqliteStoreConfig.build | build} gets, by convention named `cellar`: the functions to declare
 * its reads and caches with, and what they read, over the connection the store is being built on. Every
 * partition is named by its key, a string (see {@linkcode PartitionSpec}).
 */

/**
 * Everything {@linkcode defineSqliteStore} needs to declare a store: its name, its table, its partitions, how rows
 * arrive by fetch and by push, and how to build its reads.
 */

/** A store's functions: what its {@linkcode SqliteStoreConfig.build | build} returned, with Cellar's lifecycle and push. */

/**
 * How a store gets a working database back when a SQLite statement fails during the session. The store first reopens
 * the database (up to twice per session), then moves to an in-memory database, and only if that fails too runs on
 * nothing, returning each read's {@linkcode CommonDef.empty | empty}. Every move rebuilds the store and fetches its
 * partitions again.
 */

/** Options for {@linkcode SqliteStore.bindSqlite}. */

/**
 * A store declared with {@linkcode defineSqliteStore}. Until it is bound to a database, it runs on nothing, and every
 * read returns its {@linkcode CommonDef.empty | empty}.
 *
 * The store can move to a different database during a session (bound at startup, reopened after a failure, moved to an
 * in-memory database), and each move rebuilds its functions over the new one. {@linkcode SqliteStore.reads | reads},
 * {@linkcode SqliteStore.push | push} and {@linkcode SqliteStore.lifecycle | lifecycle} always point at the current
 * ones, looked up on each access, so code that keeps the store (or {@linkcode SqliteStore.reads | store.reads}) keeps
 * working across moves.
 */

/**
 * Answers every statement with no rows: what an unbound store runs on, so each read gives back its declared
 * {@linkcode CommonDef.empty | empty}.
 */
const NULL_CONNECTION = {
  execute: () => ({
    rows: {
      _array: []
    }
  })
};

/**
 * Reopens a store gets per session before it moves to its fallback. A database that fails again straight after a
 * reopen is failing for a reason a reopen does not fix, and each attempt costs a refetch of every partition.
 */
const MAX_REOPENS = 2;

/**
 * An error that means the file itself is unusable, so reopening it would only fail the same way. SQLite's own wording
 * only: a bare "malformed" is also how `json_extract` reports one bad value, which says nothing about the file.
 */
const CORRUPTION = /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i;
const messageOf = error => String(error?.message ?? error);

/** A failing read's statement, reported once a session per store and message. */
const statementErrors = (0, _once_guard.createOnceGuard)();

/**
 * A view of one group of the running surface, looked up at each access so that a move reaches every caller, including
 * one that took the group before it happened.
 */
function delegate(group, label) {
  const resolve = () => {
    const target = group();
    if (!target) throw new Error(`${label}: this store has no such group`);
    return target;
  };
  return new Proxy({}, {
    get: (_target, key) => Reflect.get(resolve(), key),
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), key);
      // The proxy's own target holds nothing, so every property it reports has to be configurable.
      return descriptor && {
        ...descriptor,
        configurable: true
      };
    }
  });
}

/**
 * Declares a store: a SQLite table of rows ({@linkcode SqliteStoreConfig.schema | schema}), how rows arrive by
 * {@linkcode SqliteStoreConfig.fetch | fetch} and by {@linkcode SqliteStoreConfig.push | push}, and the reads and
 * lifecycle functions {@linkcode SqliteStoreConfig.build | build} creates over it. The store starts bound to nothing,
 * where every read returns its {@linkcode CommonDef.empty | empty}, until the app binds it to a database with
 * {@linkcode SqliteStore.bindSqlite | bindSqlite} (on a device, through {@linkcode bindSqliteStore}).
 *
 * If a SQLite statement fails later in the session, the store recovers by itself when the bind supplied a
 * {@linkcode BindOptions.recovery | recovery}: it reopens the database (deleting the file first if it's corrupt), then
 * moves to an in-memory database, and only then runs on nothing. Each move rebuilds the store and re-renders its
 * readers, which fetch again.
 */
function defineSqliteStore(config) {
  const schema = (0, _partitioned.partitionedSchema)(config.schema);
  const version = (0, _version_atom.createVersionAtom)(`${config.name}_version`);
  const extra = more => ({
    store: config.name,
    table: schema.table,
    ...more
  });
  const capabilitiesOf = conn => config.capabilities ? config.capabilities(conn) : {};
  const where = key => ({
    [_partitioned.PARTITION_KEY_COLUMN]: key
  });
  const nativeShredSpec = (0, _partitioned.nativeSpecOf)(config.nativeShredSpecs);
  const keyOfPartition = partitionKeyOf;

  /** Logs a write that changed a partition, for the inspector. Wired in development builds only. */
  const recordWrite = (partition, next, changes) => {
    const entities = changes === _change_set.ALL_ENTITIES ? _change_set.ALL_ENTITIES : Array.from(changes).slice(0, _events.MAX_EVENT_ENTITIES);
    (0, _events.recordInspectorEvent)({
      kind: 'write',
      store: config.name,
      partition,
      version: next,
      entities,
      entityCount: changes === _change_set.ALL_ENTITIES ? null : changes.size
    });
  };

  /** What the inspector looks into for each surface the store builds: the connection under it, and its partitions. */
  const inspectable = new WeakMap();

  /** Declares the partitions over `table` and hands the store its context. `raw` is the connection before its guard. */
  const buildOn = (table, atom, caps, raw) => {
    table.init();
    const pushSpec = config.push;
    let ingest;
    // A store without pushes holds nothing, so its fetches needn't detect a body they already wrote.
    const holdWrites = pushSpec && (key => ingest.hold(key));
    const partitions = (0, _define_partitions.definePartitions)({
      name: config.name.replace(/_store$/, ''),
      table,
      version: atom,
      key: {
        of: config.partition,
        id: keyOfPartition,
        from: key => {
          const record = table.getMetaRecord(where(key));
          return record === undefined ? undefined : JSON.parse(record);
        },
        where
      },
      fetch: config.fetch,
      holdWrites,
      internMax: config.internMax,
      remember: (key, partition) => {
        const rowsWhere = where(key);
        if (table.getMetaRecord(rowsWhere) === undefined) table.setMeta(rowsWhere, table.getMeta(rowsWhere), JSON.stringify(partition));
      },
      ...(__DEV__ && {
        onChanged: recordWrite
      })
    });
    table.onChangesElsewhere?.(changes => _queryCore.notifyManager.batch(() => changes.forEach((entities, key) => partitions.bump(key, entities))));
    const surface = config.build({
      defineRead: partitions.defineRead,
      defineReadAcross: partitions.defineReadAcross,
      defineCaches: partitions.defineCaches,
      rows: (key, filter, opts) => (0, _row_shaping.rowsOf)(table).where(filter ? {
        ...filter,
        ...where(key)
      } : where(key), opts),
      keyOf: partitions.keyOf,
      partitionOf: partitions.partitionOf,
      keys: partitions.internedKeys,
      has: partition => partitions.has(partitions.keyOf(partition)),
      versionOf: partitions.versionOf,
      bump: partitions.bump,
      clearEtag: partitions.clearEtag,
      where,
      table,
      caps
    });
    (0, _surface.labelReads)(surface.reads);
    let push;
    if (pushSpec) {
      const {
        partitionsOf,
        etagRetireIntervalMs,
        toRows,
        ...spec
      } = pushSpec;
      const buffer = (0, _push_ingest.createPushIngest)({
        ...spec,
        toRows: (key, items) => toRows(key, items, partitions.partitionOf(key)),
        name: config.name,
        table,
        where,
        bump: partitions.bump,
        onWrite: (0, _etag_retirement.createEtagRetirement)(partitions.clearEtag, etagRetireIntervalMs)
      });
      ingest = buffer;
      push = {
        ingest: items => {
          if (!items) return;
          let dropped = 0;
          let firstError;
          for (const item of items) {
            try {
              const keys = partitionsOf(item).map(partitions.keyOf);
              const loaded = keys.filter(partitions.has);
              for (const key of loaded.length ? loaded : keys) buffer.queue(key, item);
            } catch (error) {
              dropped += 1;
              firstError ??= error;
            }
          }
          if (dropped) {
            (0, _telemetry.reportStoreDegradation)({
              scope: `${config.name}.push`,
              group: 'store.push',
              context: 'pushed items threw before they were queued, so they were dropped and their rows stay stale until the next push or fetch',
              error: firstError,
              extra: extra({
                dropped,
                total: items.length
              })
            });
          }
        }
      };
    }
    const own = surface.lifecycle;
    const forget = own?.forget ? () => {
      partitions.lifecycle.forget();
      own.forget();
    } : partitions.lifecycle.forget;
    const functions = {
      ...surface,
      ...(push && {
        push
      }),
      lifecycle: {
        ...partitions.lifecycle,
        ...own,
        forget
      }
    };
    inspectable.set(functions, {
      conn: raw,
      reads: Object.keys(surface.reads),
      internedKeys: partitions.internedKeys,
      describe: partitions.partitionOf,
      versionOf: partitions.versionOf,
      entityChanges: key => (0, _version_atom.entityChangesOf)(atom, [key]),
      entityVersionOf: (key, entityId) => atom.getEntity([key], entityId),
      fetchedAt: partitions.inspect.fetchedAt,
      refetch: partitions.inspect.refetch,
      clearEtag: partitions.clearEtag
    });
    return functions;
  };
  let running;
  let hasBeenRead = false;
  let reopens = 0;
  // What each surface the store has run on primed, so leaving it can have the next one fetch for itself.
  let resets = [];
  const buildOver = (conn, temporary, atom = version, raw = conn) => {
    const table = (0, _sqlite.createSqliteRowTable)(schema, conn, nativeShredSpec, {
      temporary
    });
    return {
      surface: buildOn(table, atom, capabilitiesOf(conn), raw),
      table
    };
  };
  let binding = {
    state: 'unbound',
    since: Date.now(),
    reopens: 0
  };
  const moveBinding = (state, database = binding.database) => {
    binding = {
      state,
      ...(database === undefined ? {} : {
        database
      }),
      since: Date.now(),
      reopens
    };
    (0, _events.recordInspectorEvent)({
      kind: 'binding',
      store: config.name,
      binding
    });
  };
  const install = surface => {
    const forget = surface.lifecycle?.forget;
    if (forget) resets.push(forget);
    running = surface;
    return surface;
  };

  /** Forgets what the running surface fetched, runs the store on `surface`, and has every reader read from it. */
  const replaceRunning = surface => {
    const previous = resets;
    resets = [];
    previous.forEach(reset => reset());
    install(surface);
    version.bumpAll();
  };

  // Built on first read, so a platform that binds first never builds it.
  const current = () => {
    hasBeenRead = true;
    return running ?? install(buildOver(NULL_CONNECTION, false).surface);
  };

  /**
   * The store over SQLite on `conn`, guarded so that a failure on it reopens the database or moves the store off it.
   */
  const buildGuarded = (conn, options) => {
    const guarded = (0, _connection.guardedConnection)(conn, (error, op) => onSqliteFailure(error, op, options), (error, op) => (0, _telemetry.reportStoreDegradation)({
      scope: `${config.name}.contention`,
      group: 'store.contention',
      context: `SQLite \`${op}\` was refused because another statement held the connection — absorbed, but the store is one ` + 'connection short of where it should be, which usually means its dedicated reader never opened',
      error,
      extra: extra({
        op
      })
    }), (error, op, sql) => {
      if (statementErrors.seen(config.name, messageOf(error))) return;
      (0, _telemetry.reportStoreDegradation)({
        scope: `${config.name}.statement_error`,
        group: 'store.statement_error',
        context: `a SQLite \`${op}\` read failed on its own statement and answered empty; the connection is fine, and the read's SQL or the value it parsed is not`,
        error,
        extra: extra({
          op,
          ...(sql ? {
            sql: sql.slice(0, 500)
          } : {})
        })
      });
    });
    return buildOver(guarded, !!options.temporary, version, conn).surface;
  };

  /**
   * The last resort: nothing to read from, reported, and handed to the binding so a later retry can bring the store
   * back.
   */
  const leaveUnbound = (context, error, options, more) => {
    (0, _telemetry.reportStoreDegradation)({
      scope: `${config.name}.unbound`,
      group: 'store.unbound',
      context,
      error,
      extra: extra(more)
    });
    replaceRunning(buildOver(NULL_CONNECTION, false).surface);
    moveBinding('unbound');
    options.recovery?.onLeftFile?.();
  };

  /** Moves the store to its in-memory fallback, or leaves it unbound when there is none. */
  const moveToFallback = (error, op, options) => {
    const fallback = options.recovery?.fallback;
    if (!fallback) {
      leaveUnbound(`SQLite \`${op}\` failed mid-session and the store has no fallback; its reads are empty until a retry binds it`, error, options, {
        op
      });
      return;
    }
    try {
      const fallbackOptions = {
        temporary: true,
        recovery: {
          reopen: options.recovery.reopen,
          onLeftFile: options.recovery.onLeftFile
        }
      };
      replaceRunning(buildGuarded(fallback(), fallbackOptions));
      moveBinding('memory');
      options.recovery?.onLeftFile?.();
      (0, _telemetry.reportStoreDegradation)({
        scope: `${config.name}.in_memory`,
        group: 'store.in_memory',
        context: `SQLite \`${op}\` kept failing on the database file; the store runs on an in-memory database and refetches into it`,
        error,
        extra: extra({
          op
        })
      });
    } catch (fallbackError) {
      leaveUnbound('the in-memory fallback could not be opened either; the store reads empty until a retry binds it', fallbackError, options, {
        op,
        firstError: messageOf(error)
      });
    }
  };

  /**
   * A statement failed, and the connection it ran on answers nothing from here. The store reopens the database — or,
   * when the file is what failed, deletes it and starts empty — and refetches into it; after that, it moves to its
   * in-memory fallback. Deferred, so the failing statement's caller unwinds first.
   */
  const onSqliteFailure = (error, op, options) => {
    queueMicrotask(() => {
      const recovery = options.recovery;
      if (!recovery || options.temporary || reopens >= MAX_REOPENS) {
        moveToFallback(error, op, options);
        return;
      }
      reopens += 1;
      const discard = CORRUPTION.test(messageOf(error));
      try {
        const conn = recovery.reopen({
          discard
        });
        // A write that failed may have left rows short of what their ETag vouches for, so each partition's next fetch
        // brings a whole body rather than a 304. The descriptions stay.
        if (!discard && schema.meta) {
          try {
            conn.execute(`UPDATE ${schema.meta.table} SET ${schema.meta.column} = NULL;`);
          } catch {
            /* a database with no meta table yet has no ETags to clear */
          }
        }
        replaceRunning(buildGuarded(conn, options));
        moveBinding('database');
        (0, _telemetry.reportStoreDegradation)({
          scope: `${config.name}.reopened`,
          context: `SQLite \`${op}\` failed mid-session; the store reopened its database${discard ? ', deleting it first,' : ''} and will refetch into it`,
          error,
          extra: extra({
            op,
            discard,
            reopens
          }),
          severity: 'info'
        });
      } catch (reopenError) {
        moveToFallback(reopenError, op, options);
      }
    });
  };
  const bindSqlite = (conn, options = {}) => {
    const surface = buildGuarded(conn, options);
    // Reported rather than warned: a startup bind that lands after a read means startup ordering moved, and that
    // read's first paint was empty.
    if (options.startup && hasBeenRead) {
      (0, _telemetry.reportStoreDegradation)({
        scope: 'store.late_bind',
        context: 'a store was bound at startup after something had already read from it, so that read painted empty first. Bind the ' + 'store earlier in startup.'
      });
    }
    if (!options.temporary) reopens = 0;
    replaceRunning(surface);
    moveBinding(options.temporary ? 'memory' : 'database', options.database);
  };

  // Looks at `running` rather than calling `current()`: looking isn't a read, and must not build the unbound surface or
  // count as one for the late-bind check.
  (0, _registry.registerInspectedStore)((0, _store.createInspectedStore)({
    name: config.name,
    schema,
    nativeShred: !!config.nativeShredSpecs,
    binding: () => binding,
    running: () => running ? inspectable.get(running) : undefined
  }));
  return {
    reads: delegate(() => current().reads, `${config.name}.reads`),
    push: config.push ? delegate(() => current().push, `${config.name}.push`) : undefined,
    lifecycle: delegate(() => current().lifecycle, `${config.name}.lifecycle`),
    bindSqlite,
    testing: {
      over: (conn, options = {}) => buildOver(conn, false, options.version),
      swap: surface => {
        running = surface;
      },
      reset: () => {
        running = undefined;
        hasBeenRead = false;
        reopens = 0;
        resets = [];
        binding = {
          state: 'unbound',
          since: Date.now(),
          reopens: 0
        };
      }
    }
  };
}

/**
 * A partition's key: its description as `name=value` pairs in name order, joined with `&`, with a list's values joined
 * with `,`. An `undefined` field is left out, and names and values are escaped.
 */
function partitionKeyOf(partition) {
  const part = value => Array.isArray(value) ? value.map(part).join(',') : encodeURIComponent(typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
  return Object.keys(partition).filter(name => partition[name] !== undefined).sort().map(name => `${encodeURIComponent(name)}=${part(partition[name])}`).join('&');
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=define_sqlite_store.js.map