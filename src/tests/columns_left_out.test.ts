import { columnsLeftOut } from '../testing/columns_left_out';

const SCHEMA = { uniqueBy: ['id'] };

describe('columnsLeftOut', () => {
  it('lists a column one fetch states for a row and another leaves absent for the same row', () => {
    expect(
      columnsLeftOut(SCHEMA, {
        catalog: [{ id: 'a', team: 'KC', height: undefined, status: undefined }],
        detail: [{ id: 'a', team: 'KC', height: '74', status: undefined }],
      }),
    ).toEqual(['height']);
  });

  it('leaves out a column absent only from rows no other fetch states it for', () => {
    expect(
      columnsLeftOut(SCHEMA, {
        catalog: [
          { id: 'a', age: 30 },
          { id: 'def', age: undefined },
        ],
        detail: [{ id: 'a', age: 30 }],
      }),
    ).toEqual([]);
  });
});
