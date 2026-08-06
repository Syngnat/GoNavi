import { buildTabularClipboardPayload, type DataGridClipboardPayload } from './dataGridClipboardPayload';

export interface SelectedGridCell {
  rowKey: string;
  colName: string;
}

export const canSelectGridCellForClipboard = ({
  canModifyData,
  isDisplayedColumn,
  isWritableColumn,
}: {
  canModifyData: boolean;
  isDisplayedColumn: boolean;
  isWritableColumn: boolean;
}): boolean => isDisplayedColumn && (!canModifyData || isWritableColumn);

const normalizeUnsafePlainTextCell = (value: string): string => (
  value.replace(/\r\n/g, '\n').replace(/[\t\n\r]+/g, ' ').trim()
);

const normalizeClipboardCellValue = (value: unknown, options: { preserveCellWhitespace?: boolean } = {}): string => {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/\r\n/g, '\n');
    return options.preserveCellWhitespace ? normalized : normalizeUnsafePlainTextCell(normalized);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    const text = JSON.stringify(value);
    if (typeof text === 'string') {
      return options.preserveCellWhitespace ? text : normalizeUnsafePlainTextCell(text);
    }
  } catch {
    // Fall through to String(value) below.
  }
  const text = String(value);
  return options.preserveCellWhitespace ? text : normalizeUnsafePlainTextCell(text);
};

export const buildSelectedCellClipboardText = ({
  selectedCells,
  rows,
  columnOrder,
  rowKeyField,
}: {
  selectedCells: SelectedGridCell[];
  rows: Array<Record<string, any>>;
  columnOrder: string[];
  rowKeyField: string;
}): string => {
  const matrix = buildSelectedCellClipboardMatrix({
    selectedCells,
    rows,
    columnOrder,
    rowKeyField,
  });

  return matrix.map((row) => row.join('\t')).join('\n');
};

const buildSelectedCellClipboardMatrix = ({
  selectedCells,
  rows,
  columnOrder,
  rowKeyField,
  preserveCellWhitespace = false,
}: {
  selectedCells: SelectedGridCell[];
  rows: Array<Record<string, any>>;
  columnOrder: string[];
  rowKeyField: string;
  preserveCellWhitespace?: boolean;
}): string[][] => {
  if (!selectedCells.length || !rows.length || !columnOrder.length || !rowKeyField) {
    return [];
  }

  const selectedRowKeys = new Set(selectedCells.map((cell) => cell.rowKey));
  const selectedColumnKeys = new Set(selectedCells.map((cell) => cell.colName));
  const orderedRows = rows.filter((row) => selectedRowKeys.has(String(row?.[rowKeyField] ?? '')));
  const orderedColumns = columnOrder.filter((columnName) => selectedColumnKeys.has(columnName));

  if (!orderedRows.length || !orderedColumns.length) {
    return [];
  }

  const selectedCellKeySet = new Set(selectedCells.map((cell) => `${cell.rowKey}::${cell.colName}`));

  return orderedRows
    .map((row) => {
      const rowKey = String(row?.[rowKeyField] ?? '');
      return orderedColumns
        .map((columnName) => {
          if (!selectedCellKeySet.has(`${rowKey}::${columnName}`)) {
            return '';
          }
          return normalizeClipboardCellValue(row?.[columnName], { preserveCellWhitespace });
        });
    });
};

export const buildSelectedCellClipboardPayload = ({
  selectedCells,
  rows,
  columnOrder,
  rowKeyField,
}: {
  selectedCells: SelectedGridCell[];
  rows: Array<Record<string, any>>;
  columnOrder: string[];
  rowKeyField: string;
}): DataGridClipboardPayload => {
  const matrix = buildSelectedCellClipboardMatrix({
    selectedCells,
    rows,
    columnOrder,
    rowKeyField,
    preserveCellWhitespace: true,
  });
  return buildTabularClipboardPayload({ rows: matrix });
};
