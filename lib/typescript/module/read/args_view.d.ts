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
import type { CommonDef, ReadDef } from './surface';
/** Thrown through a read's function when it reads an arg the caller didn't pass; the read returns its empty value. */
export declare class ArgNotPassed {
    /** The arg the function read. */
    readonly field: string;
    constructor(
    /** The arg the function read. */
    field: string);
}
/** One read's view of its args, reused for every call so a call allocates nothing for it. */
export interface ArgsView {
    /** Whether every arg in `args` has a value, apart from the optional ones. */
    ready(args: object): boolean;
    /** Runs `fn` over `args` seen through the view, and returns what it returned; throws {@linkcode ArgNotPassed}. */
    run<R>(args: object, fn: (view: never) => R): R;
    /**
     * {@linkcode ArgsView.run | run}, also returning every arg `fn` read. A `lenient` run hands `fn` a missing arg as
     * it is rather than stopping it, for a function that answers a missing value itself, such as the store's key.
     */
    record<R>(args: object, fn: (view: never) => R, lenient?: boolean): {
        value: R;
        read: ReadonlySet<string>;
    };
}
/** Creates the view one read sees its args through; `optional` names the args it may be handed without a value. */
export declare function createArgsView(optional: readonly PropertyKey[] | undefined): ArgsView;
export type { CommonDef, ReadDef };
//# sourceMappingURL=args_view.d.ts.map