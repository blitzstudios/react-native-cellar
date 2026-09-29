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
    expect(typeof nativeLabel === 'string' || nativeLabel === null).toBe(true);
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
