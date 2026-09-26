/**
 * How a read sees its args: through a view that stops the read when it reaches for an arg its caller didn't pass.
 *
 * A read is ready once every arg its caller passed has a value (`undefined`, `null`, `''` and an empty list count as
 * none; `0` and `false` are values), apart from the read's {@linkcode CommonDef.optionalArgs | optionalArgs}. Until
 * then it neither fetches nor runs {@linkcode ReadDef.select | select}. The view covers the rest: a read's functions
 * ({@linkcode ReadDef.select | select}, its partition, {@linkcode CommonDef.enabled | enabled}) read the args through
 * it, and reading one the caller left out entirely stops the function the same way, so a function is never handed a
 * missing arg it didn't declare optional.
 */

import { isArgPresent } from '../args_key';
import type { CommonDef, ReadDef } from './surface';

/** Thrown through a read's function when it reads an arg the caller didn't pass; the read returns its empty value. */
export class ArgNotPassed {
  constructor(
    /** The arg the function read. */
    readonly field: string,
  ) {}
}

/**
 * Names a caller never means as an arg: probes that tooling and the language make of any object, such as `await`
 * checking for `then`. Reading one answers from the args as they are rather than stopping the read.
 */
const PROBES: ReadonlySet<PropertyKey> = new Set(['then', 'toJSON', '$$typeof', 'constructor']);

/** One read's view of its args, reused for every call so a call allocates nothing for it. */
export interface ArgsView {
  /** Whether every arg in `args` has a value, apart from the optional ones. */
  ready(args: object): boolean;
  /** Runs `fn` over `args` seen through the view, and returns what it returned; throws {@linkcode ArgNotPassed}. */
  run<R>(args: object, fn: (view: never) => R): R;
  /** {@linkcode ArgsView.run | run}, also returning every arg `fn` read. */
  record<R>(args: object, fn: (view: never) => R): { value: R; read: ReadonlySet<string> };
}

/** Creates the view one read sees its args through; `optional` names the args it may be handed without a value. */
export function createArgsView(optional: readonly PropertyKey[] | undefined): ArgsView {
  const optionalArgs = new Set(optional ?? []);
  let current: Record<PropertyKey, unknown> = {};
  let reading: Set<string> | undefined;

  const view = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_target, field) => {
      const value = current[field];
      if (typeof field === 'symbol' || PROBES.has(field)) return value;
      reading?.add(field);
      if (optionalArgs.has(field) || isArgPresent(value)) return value;
      throw new ArgNotPassed(field);
    },
    has: (_target, field) => field in current,
    ownKeys: () => Reflect.ownKeys(current),
    getOwnPropertyDescriptor: (_target, field) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, field);
      // Reported configurable, since the view's own target holds none of these and a proxy may not claim otherwise.
      return descriptor && { ...descriptor, configurable: true };
    },
  });

  const over = <R>(args: object, fn: (view: never) => R, read: Set<string> | undefined): R => {
    // Saved and restored, so a function that calls this read again from inside itself sees its own args afterwards.
    const outer = current;
    const outerReading = reading;
    current = args as Record<PropertyKey, unknown>;
    reading = read;
    try {
      return fn(view as never);
    } finally {
      current = outer;
      reading = outerReading;
    }
  };

  return {
    ready(args) {
      for (const field of Object.keys(args)) {
        if (!optionalArgs.has(field) && !isArgPresent((args as Record<string, unknown>)[field])) return false;
      }
      return true;
    },
    run: (args, fn) => over(args, fn, undefined),
    record(args, fn) {
      const read = new Set<string>();
      return { value: over(args, fn, read), read };
    },
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { CommonDef, ReadDef };
