"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ArgNotPassed = void 0;
exports.createArgsView = createArgsView;
var _args_key = require("../args_key.js");
/**
 * How a read sees its args: through a view that stops the read when it reaches for an arg its caller didn't pass.
 *
 * A read is ready once every arg its caller passed has a value (`undefined`, `null`, `''` and an empty list count as
 * none; `0` and `false` are values), apart from the read's {@linkcode CommonDef.optionalArgs | optionalArgs}. Until
 * then it neither fetches nor runs {@linkcode ReadDef.select | select}. The view covers the rest: a read's own functions
 * ({@linkcode ReadDef.select | select}, a `partition` function, {@linkcode CommonDef.enabled | enabled}) read the args
 * through it, and reading one the caller left out entirely stops the function the same way, so a function is never
 * handed a missing arg it didn't declare optional. The store's key reads them as passed, since it is shared by reads
 * that take different args and answers a missing value itself.
 */

/** Thrown through a read's function when it reads an arg the caller didn't pass; the read returns its empty value. */
class ArgNotPassed {
  constructor(/** The arg the function read. */
  field) {
    this.field = field;
  }
}

/**
 * Names a caller never means as an arg: probes that tooling and the language make of any object, such as `await`
 * checking for `then`. Reading one answers from the args as they are rather than stopping the read.
 */
exports.ArgNotPassed = ArgNotPassed;
const PROBES = new Set(['then', 'toJSON', '$$typeof', 'constructor']);

/** One read's view of its args, reused for every call so a call allocates nothing for it. */

/** Creates the view one read sees its args through; `optional` names the args it may be handed without a value. */
function createArgsView(optional) {
  const optionalArgs = new Set(optional ?? []);
  let current = {};
  let reading;
  let strict = true;
  const view = new Proxy({}, {
    get: (_target, field) => {
      const value = current[field];
      if (typeof field === 'symbol' || PROBES.has(field)) return value;
      reading?.add(field);
      if (!strict || optionalArgs.has(field) || (0, _args_key.isArgPresent)(value)) return value;
      throw new ArgNotPassed(field);
    },
    has: (_target, field) => field in current,
    ownKeys: () => Reflect.ownKeys(current),
    getOwnPropertyDescriptor: (_target, field) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, field);
      // Reported configurable, since the view's own target holds none of these and a proxy may not claim otherwise.
      return descriptor && {
        ...descriptor,
        configurable: true
      };
    }
  });
  const over = (args, fn, read, lenient = false) => {
    // Saved and restored, so a function that calls this read again from inside itself sees its own args afterwards.
    const outer = current;
    const outerReading = reading;
    const outerStrict = strict;
    current = args;
    reading = read;
    strict = !lenient;
    try {
      return fn(view);
    } finally {
      current = outer;
      reading = outerReading;
      strict = outerStrict;
    }
  };
  return {
    ready(args) {
      for (const field of Object.keys(args)) {
        if (!optionalArgs.has(field) && !(0, _args_key.isArgPresent)(args[field])) return false;
      }
      return true;
    },
    run: (args, fn) => over(args, fn, undefined),
    record(args, fn, lenient) {
      const read = new Set();
      return {
        value: over(args, fn, read, lenient),
        read
      };
    }
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=args_view.js.map