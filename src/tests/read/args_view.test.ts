import { ArgNotPassed, createArgsView } from '../../read/args_view';

describe('createArgsView', () => {
  it('is ready once every arg it was passed has a value, apart from the optional ones', () => {
    const view = createArgsView(['team']);

    expect(view.ready({ sport: 'nfl', playerId: 'p1' })).toBe(true);
    expect(view.ready({ sport: 'nfl', playerId: null })).toBe(false);
    expect(view.ready({ sport: 'nfl', ids: [] })).toBe(false);
    expect(view.ready({ sport: 'nfl', count: 0, live: false })).toBe(true);
    expect(view.ready({ sport: 'nfl', team: undefined })).toBe(true);
  });

  it('hands a function the args, and stops it on one its caller left out', () => {
    const view = createArgsView(undefined);
    const args = { sport: 'nfl' };

    expect(view.run(args, (ready: { sport: string }) => ready.sport)).toBe('nfl');
    expect(() => view.run(args, (ready: { playerId: string }) => ready.playerId)).toThrow(ArgNotPassed);
  });

  it('hands over an optional arg without a value, as it is', () => {
    const view = createArgsView(['team']);

    expect(view.run({ sport: 'nfl' }, (ready: { team?: string }) => ready.team ?? 'all')).toBe('all');
  });

  it('answers the probes tooling makes of any object from the args as they are', () => {
    const view = createArgsView(undefined);

    expect(view.run({ sport: 'nfl' }, (ready: object) => (ready as { then?: unknown }).then)).toBeUndefined();
    expect(view.run({ sport: 'nfl' }, (ready: object) => JSON.stringify(ready))).toBe('{"sport":"nfl"}');
    expect(view.run({ sport: 'nfl', id: 'a' }, (ready: object) => Object.keys(ready))).toEqual(['sport', 'id']);
  });

  it('records every arg a function read, for telling the args that name a partition from the rest', () => {
    const view = createArgsView(undefined);

    const { value, read } = view.record({ sport: 'nfl', playerId: 'p1' }, (ready: { sport: string }) => ready.sport);

    expect(value).toBe('nfl');
    expect([...read]).toEqual(['sport']);
  });

  it('sees its own args again after a nested call on the same view', () => {
    const view = createArgsView(undefined);

    const outer = view.run({ id: 'outer' }, (ready: { id: string }) => {
      const inner = view.run({ id: 'inner' }, (nested: { id: string }) => nested.id);
      return `${inner}:${ready.id}`;
    });

    expect(outer).toBe('inner:outer');
  });
});
