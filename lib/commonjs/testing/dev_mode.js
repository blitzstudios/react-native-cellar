"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.itProd = exports.itDev = exports.devWarnings = exports.describeDev = void 0;
/**
 * Jest helpers for tests that should only run in dev or prod builds. Store suites run twice: with `__DEV__` on under
 * `jest.config.js`, and off under `jest.config.prod.js`.
 */

/** `it`, but only run when `__DEV__` is on. */
const itDev = exports.itDev = __DEV__ ? it : it.skip;

/** `it`, but only run when `__DEV__` is off. */
const itProd = exports.itProd = __DEV__ ? it.skip : it;

/** `describe`, but only run when `__DEV__` is on. */
const describeDev = exports.describeDev = __DEV__ ? describe : describe.skip;

/** `count` when `__DEV__` is on, otherwise 0, for asserting how many dev warnings fired in both builds. */
const devWarnings = count => __DEV__ ? count : 0;
exports.devWarnings = devWarnings;
//# sourceMappingURL=dev_mode.js.map