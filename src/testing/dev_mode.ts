/**
 * Jest helpers for tests that should only run in dev or prod builds. Store suites run twice: with `__DEV__` on under
 * `jest.config.js`, and off under `jest.config.prod.js`.
 */

/** `it`, but only run when `__DEV__` is on. */
export const itDev = __DEV__ ? it : it.skip;

/** `it`, but only run when `__DEV__` is off. */
export const itProd = __DEV__ ? it.skip : it;

/** `describe`, but only run when `__DEV__` is on. */
export const describeDev = __DEV__ ? describe : describe.skip;

/** `count` when `__DEV__` is on, otherwise 0, for asserting how many dev warnings fired in both builds. */
export const devWarnings = (count: number): number => (__DEV__ ? count : 0);
