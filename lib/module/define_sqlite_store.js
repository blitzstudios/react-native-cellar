"use strict";

/**
 * Declares a store: a SQLite table of rows plus the reads, pushes and lifecycle functions built over it. A store runs
 * on SQLite everywhere (the device's SQLite on mobile, and sql.js, SQLite compiled to WebAssembly, on web and in
 * tests), and can move between databases during a session without its callers noticing.
 */

import { reportStoreDegradation } from "./diagnostics/telemetry.js";
import { createVersionAtom } from "./reactivity/version_atom.js";
import { guardedConnection } from "./table/connection.js";
import { createSqliteRowTable } from "./table/sqlite.js";
import { labelReads } from "./read/surface.js";

/**
 * Objects a store builds from its database connection besides its row table, such as a ranker that runs its own SQL
 * queries. They are rebuilt with the rest of the store whenever it moves to another connection, and passed to
 * {@linkcode SqliteStoreConfig.build | build} as `caps`.
 */

/**
 * What a store's {@linkcode SqliteStoreConfig.build | build} returns: the store's public functions, in three groups.
 * Callers reach them through the store (`store.reads.x`), which always points at the surface built over the database
 * the store currently runs on.
 */

/**
 * Everything {@linkcode defineSqliteStore} needs to declare a store: its name, its table, and how to build its
 * functions.
 */

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

/** An error that means the file itself is unusable, so reopening it would only fail the same way. */
const CORRUPTION = /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database/i;
const messageOf = error => String(error?.message ?? error);

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
 * Declares a store: a SQLite table of rows ({@linkcode SqliteStoreConfig.schema | schema}) plus the reads, pushes and
 * lifecycle functions {@linkcode SqliteStoreConfig.build | build} creates over it. The store starts bound to nothing,
 * where every read returns its {@linkcode CommonDef.empty | empty}, until the app binds it to a database with
 * {@linkcode SqliteStore.bindSqlite | bindSqlite} (on a device, through {@linkcode bindSqliteStore}).
 *
 * If a SQLite statement fails later in the session, the store recovers by itself when the bind supplied a
 * {@linkcode BindOptions.recovery | recovery}: it reopens the database (deleting the file first if it's corrupt), then
 * moves to an in-memory database, and only then runs on nothing. Each move rebuilds the store and re-renders its
 * readers, which fetch again.
 */
export function defineSqliteStore(config) {
  const version = createVersionAtom(`${config.name}_version`);
  const extra = more => ({
    store: config.name,
    table: config.schema.table,
    ...more
  });
  const capabilitiesOf = conn => config.capabilities ? config.capabilities(conn) : {};
  let running;
  let hasBeenRead = false;
  let reopens = 0;
  // What each surface the store has run on primed, so leaving it can have the next one fetch for itself.
  let resets = [];
  const buildOver = (conn, temporary, atom = version) => {
    const table = createSqliteRowTable(config.schema, conn, config.nativeShredSpec, {
      temporary
    });
    const surface = config.build(table, atom, capabilitiesOf(conn));
    labelReads(surface.reads);
    return {
      surface,
      table
    };
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
    const guarded = guardedConnection(conn, (error, op) => onSqliteFailure(error, op, options), (error, op) => reportStoreDegradation({
      scope: `${config.name}.contention`,
      context: `SQLite \`${op}\` was refused because another statement held the connection — absorbed, but the store is one ` + 'connection short of where it should be, which usually means its dedicated reader never opened',
      error,
      extra: extra({
        op
      })
    }));
    return buildOver(guarded, !!options.temporary).surface;
  };

  /**
   * The last resort: nothing to read from, reported, and handed to the binding so a later retry can bring the store
   * back.
   */
  const leaveUnbound = (context, error, options, more) => {
    reportStoreDegradation({
      scope: `${config.name}.unbound`,
      context,
      error,
      extra: extra(more)
    });
    replaceRunning(buildOver(NULL_CONNECTION, false).surface);
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
      options.recovery?.onLeftFile?.();
      reportStoreDegradation({
        scope: `${config.name}.in_memory`,
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
        // brings a whole body rather than a 304.
        if (!discard && config.schema.meta) {
          try {
            conn.execute(`DELETE FROM ${config.schema.meta.table};`);
          } catch {
            /* a database with no meta table yet has no ETags to clear */
          }
        }
        replaceRunning(buildGuarded(conn, options));
        reportStoreDegradation({
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
      reportStoreDegradation({
        scope: 'store.late_bind',
        context: 'a store was bound at startup after something had already read from it, so that read painted empty first. Move the ' + '`bindOffHeapStore` call earlier in startup.'
      });
    }
    if (!options.temporary) reopens = 0;
    replaceRunning(surface);
  };
  return {
    reads: delegate(() => current().reads, `${config.name}.reads`),
    push: delegate(() => current().push, `${config.name}.push`),
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
      }
    }
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=define_sqlite_store.js.map