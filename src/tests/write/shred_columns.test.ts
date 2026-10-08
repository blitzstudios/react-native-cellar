import { SqlValue } from '../../table/types';
import { defineShredColumns, shredColumnValue, ShredColumn } from '../../write/shred_columns';
import { evalShredElement } from '../../write/shred_spec';

type Item = Record<string, unknown>;

const COLUMNS = [
  { name: 'id', type: 'TEXT', notNull: true, op: { op: 'coalesceText', paths: ['id', 'player.id'], emptyDefault: true } },
  { name: 'team', type: 'TEXT', op: { op: 'text', path: 'team' } },
  { name: 'number', type: 'INTEGER', op: { op: 'int', path: 'number' } },
  { name: 'rec', type: 'REAL', op: { op: 'real0', path: 'stats.rec' } },
  { name: 'active', type: 'INTEGER', op: { op: 'boolInt', path: 'active' } },
  { name: 'game_id', type: 'TEXT', op: { op: 'metaText', path: 'game_id' } },
  { name: 'row_id', type: 'TEXT', op: { op: 'concat', sep: '_', parts: [{ paths: ['game_id'] }, { paths: ['id', 'player.id'] }] } },
  { name: 'positions', type: 'TEXT', op: { op: 'rawJsonField', path: 'positions' } },
  { name: 'label', type: 'TEXT', js: (item: Item): string => `#${String(item.team ?? '')}`, op: { op: 'text', path: 'team' } },
] as const satisfies readonly ShredColumn<Item>[];

const shred = defineShredColumns<Item>()(COLUMNS);

/** The row the native shredder writes for `item`, from the same columns' ops. */
const nativeRow = (item: Item) => evalShredElement({ version: 1, table: 't', insertVerb: 'INSERT', columns: shred.names, ops: shred.ops }, item, []);

describe('defineShredColumns — a column declared by its op alone', () => {
  const items: Array<[string, Item]> = [
    ['a full element', { id: 'p1', team: 'SF', number: 13, stats: { rec: 6 }, active: true, game_id: 'g1', positions: ['WR', 'TE'] }],
    ['missing fields', {}],
    ['the id only on the nested player', { player: { id: 'p2' }, game_id: 7 }],
    ['values of the wrong type', { id: 3, team: 12, number: '13', stats: { rec: '6.5' }, active: 0, game_id: 99, positions: 'WR' }],
  ];

  it.each(items)('builds %s the way the native shredder does', (_label, item) => {
    const { label, ...fromOps } = shred.row(item, undefined);
    const { label: nativeLabel, ...native } = nativeRow(item)!;
    expect(fromOps).toEqual(native);
    expect(typeof nativeLabel === 'string' || nativeLabel == null).toBe(true);
    expect(label).toBe(`#${String(item.team ?? '')}`);
  });

  it('stores a mistyped field as the op does, not as the payload spelled it', () => {
    const row = shred.row({ id: 'p1', team: 12, number: '13' }, undefined);
    expect(row.team).toBeNull();
    expect(row.number).toBeNull();
  });

  it('fails at definition for a column with no builder whose op reads a bind', () => {
    const columns = [{ name: 'sport', type: 'TEXT', op: { op: 'coalesceText', paths: ['sport'], fallbackBindIndex: 0 } }] as unknown as readonly ShredColumn<Item>[];
    expect(() => defineShredColumns<Item>()(columns)).toThrow(/needs a js builder/);
  });

  it('computes one column as the row does, by its builder or its op', () => {
    const item: Item = { id: 'p1', team: 'KC', number: 15 };
    const row = shred.row(item, undefined);
    for (const column of shred.columns) expect(shredColumnValue(column, item, undefined)).toEqual((row as Record<string, unknown>)[column.name]);
  });
});

describe('defineShredColumns — decode, a stored row read back', () => {
  const stored = shred.row({ id: 'p1', team: 'SF', number: 13, stats: { rec: 6 }, active: true, positions: ['WR', 'TE'] }, undefined);
  const empty = shred.row({ id: 'p2' }, undefined);

  it('reads each named column as its op stored it, and nothing it was not asked for', () => {
    expect(shred.decode(stored, ['id', 'team', 'number', 'rec'])).toEqual({ id: 'p1', team: 'SF', number: 13, rec: 6 });
  });

  it('reads a boolInt as a boolean, and a rawJsonField parsed', () => {
    expect(shred.decode(stored, ['active', 'positions'])).toEqual({ active: true, positions: ['WR', 'TE'] });
    expect(shred.decode(shred.row({ id: 'p3', active: false }, undefined), ['active']).active).toBe(false);
  });

  it('reads a NULL as undefined, or as null when the caller asks', () => {
    expect(shred.decode(empty, ['team', 'active', 'positions'])).toEqual({ team: undefined, active: undefined, positions: undefined });
    expect(shred.decode(empty, ['team', 'active'], { absent: null })).toEqual({ team: null, active: null });
  });

  it('reads JSON that does not parse as absent rather than throwing, since it runs during render', () => {
    expect(shred.decode({ positions: '[not json' }, ['positions']).positions).toBeUndefined();
  });

  it("reads a column through its own decode, and that decode's null as absent", () => {
    const decoded = defineShredColumns<Item>()([
      {
        name: 'positions',
        type: 'TEXT',
        op: { op: 'rawJsonField', path: 'positions' },
        decode: (value: SqlValue) => {
          const list = typeof value === 'string' ? (JSON.parse(value) as unknown[]) : [];
          return list.length ? list.filter((part): part is string => typeof part === 'string') : null;
        },
      },
    ] as const satisfies readonly ShredColumn<Item>[]);

    expect(decoded.decode({ positions: '["WR", 3, "TE"]' }, ['positions']).positions).toEqual(['WR', 'TE']);
    expect(decoded.decode({ positions: '[]' }, ['positions'], { absent: null }).positions).toBeNull();
  });

  it('fails for a name the table does not declare, which only a JS caller can pass', () => {
    expect(() => shred.decode(stored, ['nope'] as never)).toThrow(/not a column/);
  });
});
