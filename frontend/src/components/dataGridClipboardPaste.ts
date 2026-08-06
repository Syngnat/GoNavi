export type DataGridClipboardValue = string | null;

export interface DataGridClipboardDataReader {
  types?: readonly string[] | DOMStringList;
  getData: (format: string) => string;
}

export interface DataGridClipboardPasteRow {
  rowKey: string;
  values: Record<string, DataGridClipboardValue>;
  modifiedValues: Record<string, any>;
  modifiedColumnNames: string[];
  isAdded: boolean;
}

const toClipboardValue = (value: string): DataGridClipboardValue => (
  value === 'NULL' ? null : value
);

export const parseDataGridClipboardText = (text: string): DataGridClipboardValue[][] => {
  const normalized = text.replace(/\r\n?/g, '\n');
  const content = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;

  return content.split('\n').map((line) => (
    line.split('\t').map(toClipboardValue)
  ));
};

const parseDelimitedClipboardText = (text: string, delimiter: ',' | '\t'): DataGridClipboardValue[][] => {
  const normalized = text.replace(/\r\n?/g, '\n');
  const content = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const rows: DataGridClipboardValue[][] = [];
  let row: DataGridClipboardValue[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(toClipboardValue(cell));
      cell = '';
      continue;
    }
    if (char === '\n') {
      row.push(toClipboardValue(cell));
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }

  row.push(toClipboardValue(cell));
  rows.push(row);
  return rows;
};

export const parseDataGridClipboardCsv = (text: string): DataGridClipboardValue[][] => (
  parseDelimitedClipboardText(text, ',')
);

const decodeHtmlEntities = (text: string): string => (
  text
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
);

const normalizeHtmlCellContent = (html: string): string => (
  decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
);

export const parseDataGridClipboardHtml = (html: string): DataGridClipboardValue[][] => {
  if (!String(html || '').trim()) return [];
  const rows: DataGridClipboardValue[][] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1] || '';
    const cells: DataGridClipboardValue[] = [];
    const cellPattern = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
      cells.push(toClipboardValue(normalizeHtmlCellContent(cellMatch[1] || '')));
    }
    if (cells.length > 0) rows.push(cells);
  }

  return rows;
};

const getClipboardTypes = (clipboardData: DataGridClipboardDataReader): string[] => (
  Array.from(clipboardData.types || [])
);

const hasClipboardType = (clipboardData: DataGridClipboardDataReader, type: string): boolean => (
  getClipboardTypes(clipboardData).includes(type)
);

const hasPasteMatrixValues = (matrix: DataGridClipboardValue[][]): boolean => (
  matrix.length > 0 && matrix.some((row) => row.length > 0)
);

export const parseDataGridClipboardData = (
  clipboardData: DataGridClipboardDataReader | null | undefined,
): DataGridClipboardValue[][] => {
  if (!clipboardData) return [];

  if (hasClipboardType(clipboardData, 'text/html')) {
    const matrix = parseDataGridClipboardHtml(clipboardData.getData('text/html'));
    if (hasPasteMatrixValues(matrix)) return matrix;
  }

  if (hasClipboardType(clipboardData, 'text/csv')) {
    const matrix = parseDataGridClipboardCsv(clipboardData.getData('text/csv'));
    if (hasPasteMatrixValues(matrix)) return matrix;
  }

  if (hasClipboardType(clipboardData, 'text/plain')) {
    return parseDataGridClipboardText(clipboardData.getData('text/plain'));
  }

  return [];
};

export const buildDataGridClipboardPasteRows = ({
  matrix,
  rows,
  columnNames,
  startRowIndex,
  startColumnIndex,
  targetCells,
  rowKeyField,
  addedRowKeys,
  modifiedRows,
  deletedRowKeys,
  isWritableColumn,
  isValueEqual,
}: {
  matrix: DataGridClipboardValue[][];
  rows: Array<Record<string, any>>;
  columnNames: string[];
  startRowIndex: number;
  startColumnIndex: number;
  targetCells?: Array<{ rowIndex: number; columnIndex: number }>;
  rowKeyField: string;
  addedRowKeys: Set<string>;
  modifiedRows: Record<string, any>;
  deletedRowKeys: Set<string>;
  isWritableColumn: (columnName: string) => boolean;
  isValueEqual: (left: any, right: any) => boolean;
}): { rows: DataGridClipboardPasteRow[]; updatedCellCount: number } => {
  if (!matrix.length || startRowIndex < 0 || startColumnIndex < 0) {
    return { rows: [], updatedCellCount: 0 };
  }

  const valuesByRowIndex = new Map<number, Array<{ columnIndex: number; value: DataGridClipboardValue }>>();
  const appendValue = (rowIndex: number, columnIndex: number, value: DataGridClipboardValue) => {
    const rowValues = valuesByRowIndex.get(rowIndex) || [];
    rowValues.push({ columnIndex, value });
    valuesByRowIndex.set(rowIndex, rowValues);
  };

  if (targetCells && matrix.length === 1 && matrix[0]?.length === 1) {
    targetCells.forEach(({ rowIndex, columnIndex }) => appendValue(rowIndex, columnIndex, matrix[0][0]));
  } else {
    matrix.forEach((sourceValues, sourceRowIndex) => {
      sourceValues.forEach((value, sourceColumnIndex) => {
        appendValue(startRowIndex + sourceRowIndex, startColumnIndex + sourceColumnIndex, value);
      });
    });
  }

  const pasteRows: DataGridClipboardPasteRow[] = [];
  let updatedCellCount = 0;

  valuesByRowIndex.forEach((targetValues, targetRowIndex) => {
    const baseRow = rows[targetRowIndex];
    const rowKeyValue = baseRow?.[rowKeyField];
    if (rowKeyValue === undefined || rowKeyValue === null) return;

    const rowKey = String(rowKeyValue);
    if (deletedRowKeys.has(rowKey)) return;

    const existing = modifiedRows[rowKey] || {};
    const currentRow = addedRowKeys.has(rowKey) ? baseRow : { ...baseRow, ...existing };
    const values: Record<string, DataGridClipboardValue> = {};

    targetValues.forEach(({ columnIndex, value }) => {
      const columnName = columnNames[columnIndex];
      if (!columnName || !isWritableColumn(columnName)) return;
      if (isValueEqual(currentRow?.[columnName], value)) return;
      values[columnName] = value;
      updatedCellCount += 1;
    });

    if (Object.keys(values).length === 0) return;

    const modifiedValues: Record<string, any> = {};
    const modifiedColumnNames: string[] = [];
    if (!addedRowKeys.has(rowKey)) {
      const candidateValues = { ...existing, ...values };
      Object.keys(candidateValues).forEach((columnName) => {
        if (!isValueEqual(baseRow?.[columnName], candidateValues[columnName])) {
          modifiedValues[columnName] = candidateValues[columnName];
          modifiedColumnNames.push(columnName);
        }
      });
    }

    pasteRows.push({
      rowKey,
      values,
      modifiedValues,
      modifiedColumnNames,
      isAdded: addedRowKeys.has(rowKey),
    });
  });

  return { rows: pasteRows, updatedCellCount };
};
