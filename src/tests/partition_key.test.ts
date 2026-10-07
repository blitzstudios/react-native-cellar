import { partitionKeyOf } from '../define_sqlite_store';

describe('partitionKeyOf — a partition key is its description, serialized', () => {
  it('writes each field as name=value, in name order', () => {
    expect(partitionKeyOf({ sport: 'nfl', season: '2025', seasonType: 'regular' })).toBe('season=2025&seasonType=regular&sport=nfl');
    expect(partitionKeyOf({ seasonType: 'regular', sport: 'nfl', season: '2025' })).toBe('season=2025&seasonType=regular&sport=nfl');
  });

  it('reads a field left undefined as one left out', () => {
    expect(partitionKeyOf({ request: 'season', teams: undefined, sport: 'nfl' })).toBe(partitionKeyOf({ request: 'season', sport: 'nfl' }));
  });

  it('keeps a list in its order, so a description holds one order', () => {
    expect(partitionKeyOf({ teams: ['ATL', 'NE'] })).toBe('teams=ATL,NE');
    expect(partitionKeyOf({ teams: ['NE', 'ATL'] })).not.toBe(partitionKeyOf({ teams: ['ATL', 'NE'] }));
  });

  it('escapes what would read as a separator', () => {
    expect(partitionKeyOf({ sport: 'clubsoccer:epl' })).toBe('sport=clubsoccer%3Aepl');
    expect(partitionKeyOf({ a: 'x&b=y' })).not.toBe(partitionKeyOf({ a: 'x', b: 'y' }));
    expect(partitionKeyOf({ teams: ['A,B'] })).not.toBe(partitionKeyOf({ teams: ['A', 'B'] }));
  });

  it('tells two kinds of partition apart by their fields, whatever their values', () => {
    expect(partitionKeyOf({ request: 'week', week: 5 })).not.toBe(partitionKeyOf({ request: 'game', gameId: '5' }));
    expect(partitionKeyOf({ request: 'player', sport: 'nfl', playerId: '4046' })).toBe('playerId=4046&request=player&sport=nfl');
  });
});
