"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.pairRead = pairRead;
/**
 * The types a store's service (its public API, such as `playerService`) is written with, and {@linkcode pairRead},
 * which publishes each of a store's reads as a hook and a getter taking one `{ params, options }` argument.
 */

/**
 * An id a caller may not have yet, such as a route param still loading. A published read accepts it as is, and returns
 * {@linkcode CommonDef.empty | empty} until it has a value (`undefined`, `null` and `''` count as not having one).
 */

/** The {@linkcode ReadOptions.options | options} part of a published read hook's argument, `{ params, options }`. */

/**
 * `T` with every value nullable. A published read takes its params this way: a caller passes every field `T` requires,
 * each as a value it may not have yet (`string | null | undefined`), and the read returns
 * {@linkcode CommonDef.empty | empty} until they arrive. A field `T` makes optional may still be left out.
 */

/**
 * A store read as a service publishes it (from {@linkcode pairRead}): a hook for components and a getter for other
 * code, which return the same value. The hook is named with `use` so React Compiler treats it as a hook rather than
 * memoizing the call away.
 */

/**
 * Publishes a store read as a hook ({@linkcode Read.useValue | useValue}) and a getter
 * ({@linkcode Read.getValue | getValue}) for a service's public API, each taking one `{ params }` argument. `read`
 * returns the read from the store, such as `() => playerStore.reads.byId`; it is called on every use, so it always
 * reaches the read built over the store's current database. The params are the read's args with every value nullable,
 * and both return {@linkcode CommonDef.empty | empty} until each has one (`undefined`, `null`, `''` and an empty list
 * count as none), apart from the read's {@linkcode CommonDef.optionalArgs | optionalArgs}: the read itself waits for
 * them, fetching nothing meanwhile.
 *
 * The two return the same value but fetch differently. {@linkcode Read.useValue | useValue} fetches through React
 * Query, and refetches when the partition is older than its {@linkcode RawQuery.staleTime | staleTime}.
 * {@linkcode Read.getValue | getValue} fetches only a partition that has never been fetched: a one-off call has no
 * component to refresh, and a getter called in a loop would otherwise flood the network.
 */
function pairRead(read) {
  // Sound because a read runs nothing until every value it was passed is in hand.
  const argsOf = params => params;
  return {
    useValue: args => read().useValue(argsOf(args.params), args.options),
    getValue: args => read().getValue(argsOf(args.params))
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=facade.js.map