"use strict";

/**
 * Kernel services for tests, as Jest mocks: every query call and error report is recorded,
 * {@linkcode QueryClient.fetchQuery | fetchQuery} runs the query's {@linkcode QuerySpec.queryFn | queryFn}, and
 * {@linkcode QueryRuntime.useQuery | useQuery} reports idle. Install once per test file, at module scope.
 */

import { configureCellar } from "../runtime.js";
const IDLE = {
  isInitialLoading: false,
  isFetching: false,
  isError: false
};

/** The mocks {@linkcode installTestRuntime} installs, one per service method. */

/** Configures Cellar with Jest mocks for its query runtime and error sink, and returns them. */
export function installTestRuntime() {
  const spies = {
    fetchQuery: jest.fn(spec => spec.queryFn()),
    invalidateQueries: jest.fn(),
    removeQueries: jest.fn(),
    useQuery: jest.fn(() => IDLE),
    useQueries: jest.fn(({
      queries
    }) => queries.map(() => IDLE)),
    captureException: jest.fn(),
    captureMessage: jest.fn()
  };
  configureCellar({
    errors: {
      captureException: (error, context) => spies.captureException(error, context),
      captureMessage: (message, context) => spies.captureMessage(message, context)
    },
    query: {
      client: () => ({
        fetchQuery: spec => spies.fetchQuery(spec),
        invalidateQueries: filters => spies.invalidateQueries(filters),
        removeQueries: filters => spies.removeQueries(filters)
      }),
      useQuery: spec => spies.useQuery(spec),
      useQueries: specs => spies.useQueries(specs)
    }
  });
  return spies;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=runtime.js.map