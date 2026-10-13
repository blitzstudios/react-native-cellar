import { formatCell, isBlob, parseJsonText } from './format';

/** A selected cell, or with no `column` its whole row. */
export interface SelectedCell {
  row: number;
  column?: number;
}

/** A query's rows as a table; clicking a cell, or a row's number, selects it, for its whole value to show beside the grid. */
export function ResultGrid({
  columns,
  rows,
  selected,
  onSelect,
  firstRow = 1,
}: {
  firstRow?: number;
  columns: readonly string[];
  rows: readonly unknown[][];
  selected?: SelectedCell;
  onSelect: (cell: SelectedCell) => void;
}) {
  return (
    <div className="grid-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th className="rownum">#</th>
            {columns.map((column, index) => (
              <th key={`${column}-${index}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const rowSelected = selected?.row === rowIndex && selected.column === undefined;
            return (
              <tr key={rowIndex} className={rowSelected ? 'row-selected' : undefined}>
                <td className="rownum" onClick={() => onSelect({ row: rowIndex })} title="Open this row">
                  {rowIndex + firstRow}
                </td>
                {row.map((value, columnIndex) => {
                  const isSelected = selected?.row === rowIndex && selected.column === columnIndex;
                  const kind =
                    value === null || value === undefined
                      ? 'null'
                      : isBlob(value)
                        ? 'blob'
                        : typeof value === 'number'
                          ? 'number'
                          : parseJsonText(value) !== undefined
                            ? 'json'
                            : 'text';
                  return (
                    <td
                      key={columnIndex}
                      className={`cell cell-${kind}${isSelected ? ' cell-selected' : ''}`}
                      onClick={() => onSelect({ row: rowIndex, column: columnIndex })}
                      title={kind === 'text' || kind === 'json' ? String(value).slice(0, 500) : undefined}
                    >
                      {formatCell(value)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
