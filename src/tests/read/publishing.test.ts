import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createCoverage } from '../../read/coverage';
import { reactQueryRuntime } from '../../runtime';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}



describe('createCoverage', () => {
  it('answers covered ids from the list above, a pending one included, and leaves the rest to the row', () => {
    const coverage = createCoverage<string>('Test');
    const answers: ({ value: string | undefined } | undefined)[] = [];
    const Row = ({ id }: { id: string }) => {
      answers.push(coverage.useCovered('nfl', id));
      return null;
    };

    render(
      React.createElement(
        coverage.Provider,
        { scope: 'nfl', ids: ['a', 'b'], values: { a: 'card a' } },
        React.createElement(Row, { id: 'a' }),
        React.createElement(Row, { id: 'b' }),
        React.createElement(Row, { id: 'c' }),
      ),
    );

    expect(answers).toEqual([{ value: 'card a' }, { value: undefined }, undefined]);
  });
});

describe('reactQueryRuntime', () => {
  it('takes React Query’s hooks with their own generics, and calls them with a QuerySpec', () => {
    const useQuery = jest.fn(<TData,>(_options: { queryKey: readonly unknown[]; select?: (data: unknown) => TData }) => ({
      isInitialLoading: false,
      isFetching: false,
      isError: false,
      data: undefined as TData | undefined,
    }));
    const runtime = reactQueryRuntime({
      client: () => ({}) as never,
      useQuery,
      useQueries: jest.fn(() => []),
    });

    runtime.useQuery({ queryKey: ['p'], queryFn: async () => 1 });
    expect(useQuery).toHaveBeenCalledWith({ queryKey: ['p'], queryFn: expect.any(Function) });
  });
});
