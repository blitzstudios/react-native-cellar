/** Keys that can each be marked once, for firing a warning once. {@linkcode resetOnceGuards} clears every guard. */
/** A set of keys that can each be marked once. */
interface OnceGuard {
    /** Whether the key made of these parts was already marked; marks it if not. */
    seen(...parts: readonly string[]): boolean;
    /** Whether the key made of these parts is marked, without marking it. */
    has(...parts: readonly string[]): boolean;
}
/**
 * Creates a set of keys that can each be marked once, for a warning or report that would otherwise fire on every call,
 * such as a dev warning during render or a Sentry report on a path a socket hits thousands of times.
 */
export declare function createOnceGuard(): OnceGuard;
/**
 * Runs `reset` whenever {@linkcode resetOnceGuards} does, for other state a warning keeps, such as a batch it collects.
 */
export declare function onGuardReset(reset: () => void): void;
/**
 * Clears every guard's marks. Marks outlast a test, so a test that expects a warning should call this first, or its
 * result depends on the tests that ran before it.
 */
export declare function resetOnceGuards(): void;
export {};
//# sourceMappingURL=once_guard.d.ts.map