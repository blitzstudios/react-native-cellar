/**
 * Jest helpers for tests that should only run in dev or prod builds. Store suites run twice: with `__DEV__` on under
 * `jest.config.js`, and off under `jest.config.prod.js`.
 */
/** `it`, but only run when `__DEV__` is on. */
export declare const itDev: jest.It;
/** `it`, but only run when `__DEV__` is off. */
export declare const itProd: jest.It;
/** `describe`, but only run when `__DEV__` is on. */
export declare const describeDev: jest.Describe;
/** `count` when `__DEV__` is on, otherwise 0, for asserting how many dev warnings fired in both builds. */
export declare const devWarnings: (count: number) => number;
//# sourceMappingURL=dev_mode.d.ts.map