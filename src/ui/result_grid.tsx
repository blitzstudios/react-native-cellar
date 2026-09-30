import { formatCell, isBlob, parseJsonText } from './format';

export interface SelectedCell {
  row: number;
  column: number;
}

/** A query's rows as a table; clicking a cell selects it, for its whole value to show beside the grid. */
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
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="rownum">{rowIndex + firstRow}</td>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
