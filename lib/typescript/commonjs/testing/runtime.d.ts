/**
 * Kernel services for tests, as Jest mocks: every query call and error report is recorded,
 * {@linkcode QueryClient.fetchQuery | fetchQuery} runs the query's {@linkcode QuerySpec.queryFn | queryFn}, and
 * {@linkcode QueryRuntime.useQuery | useQuery} reports idle. Install once per test file, at module scope.
 */
import { QuerySpec } from '../runtime';
import type { QueryClient, QueryRuntime } from '../runtime';
/** The mocks {@linkcode installTestRuntime} installs, one per service method. */
export interface TestRuntime {
    /** Runs the query's {@linkcode QuerySpec.queryFn | queryFn}. */
    fetchQuery: jest.Mock;
    invalidateQueries: jest.Mock;
    removeQueries: jest.Mock;
    /** Returns an idle status. */
    useQuery: jest.Mock;
    /** Returns an idle status per query. */
    useQueries: jest.Mock;
    captureException: jest.Mock;
    captureMessage: jest.Mock;
}
/** Configures Cellar with Jest mocks for its query runtime and error sink, and returns them. */
export declare function installTestRuntime(): TestRuntime;
export type { QueryClient, QueryRuntime, QuerySpec };
//# sourceMappingURL=runtime.d.ts.map