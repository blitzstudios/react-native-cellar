/** Keys that can each be marked once, for firing a warning once. {@linkcode resetOnceGuards} clears every guard. */

import { cacheKey } from '../key';

const resets: Array<() => void> = [];

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
export function createOnceGuard(): OnceGuard {
  const marked = new Set<string>();
  resets.push(() => marked.clear());
  return {
    seen(...parts) {
      const key = cacheKey(...parts);
      if (marked.has(key)) return true;
      marked.add(key);
      return false;
    },
    has: (...parts) => marked.has(cacheKey(...parts)),
  };
}

/**
 * Runs `reset` whenever {@linkcode resetOnceGuards} does, for other state a warning keeps, such as a batch it collects.
 */
export function onGuardReset(reset: () => void): void {
  resets.push(reset);
}

/**
 * Clears every guard's marks. Marks outlast a test, so a test that expects a warning should call this first, or its
 * result depends on the tests that ran before it.
 */
export function resetOnceGuards(): void {
  for (const reset of resets) reset();
}
