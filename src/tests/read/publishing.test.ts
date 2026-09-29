import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { lookupRead, publishReads } from '../../read/facade';
import { createCoverage } from '../../read/coverage';
import { reactQueryRuntime } from '../../runtime';
import { makeResult } from '../../store_result';
import type { Read } from '../../read/surface';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

const fakeRead = <A, T>(value: (args: A) => T): Read<A, T> => ({
  getValue: (args) => value(args as A),
  useValue: (args) => makeResult(value(args as A), 'success'),
});

describe('publishReads', () => {
  it('pairs every read of the store under its own name, reaching the store’s current reads on each use', () => {
    let reads = { Player: fakeRead((args: { id: string }) => `v1:${args.id}`) };
    const Reads = publishReads(() => reads);

    expect(Reads.Player.getValue({ params: { id: '1' } })).toBe('v1:1');
    reads = { Player: fakeRead((args: { id: string }) => `v2:${args.id}`) };
    expect(Reads.Player.getValue({ params: { id: '1' } })).toBe('v2:1');
    expect(Reads.Player).toBe(Reads.Player);
  });
});

describe('lookupRead', () => {
  it('hands back a lookup whose identity changes with the partition’s version and nothing else', () => {
    let version = 1;
    const usePrimeAndVersion = () => () => makeResult(version, 'success');
    const useLookup = lookupRead<{ sport: string }, { id: string }, string>(usePrimeAndVersion, () =>
      fakeRead((args: { sport: string; id: string }) => `${args.sport}:${args.id}`),
    );
    const seen: ((rest: { id: string }) => string)[] = [];
    const Probe = () => {
      seen.push(useLookup({ params: { sport: 'nfl' } }) as (rest: { id: string }) => string);
      return null;
    };

    const renderer = render(React.createElement(Probe));
    act(() => renderer.update(React.createElement(Probe)));
    version = 2;
    act(() => renderer.update(React.createElement(Probe)));

    expect(seen[0]({ id: '4046' })).toBe('nfl:4046');
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[1]);
  });
});

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
