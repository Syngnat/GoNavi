export interface DataGridTextRange {
  start: number;
  end: number;
}

export interface DataGridFindSummary {
  matchedCellCount: number;
  occurrenceCount: number;
}

export interface DataGridFindResult {
  matches: DataGridFindMatch[];
  summary: DataGridFindSummary;
}

export interface DataGridFindMatch extends DataGridTextRange {
  rowIndex: number;
  rowKey: string;
  columnName: string;
  columnIndex: number;
  occurrenceIndex: number;
}

export type DataGridFindNavigationDirection = 'previous' | 'next';

export const DATA_GRID_FIND_RENDER_VERSION = Symbol('DATA_GRID_FIND_RENDER_VERSION');

export const normalizeDataGridFindQuery = (value: unknown): string => {
  const text = String(value ?? '');
  return text.trim().length === 0 ? '' : text;
};

export const findDataGridTextRanges = (text: string, query: string): DataGridTextRange[] => {
  const normalizedQuery = normalizeDataGridFindQuery(query);
  if (!text || !normalizedQuery) return [];

  const source = String(text);
  const lowerSource = source.toLocaleLowerCase();
  const lowerQuery = normalizedQuery.toLocaleLowerCase();
  const ranges: DataGridTextRange[] = [];
  let startIndex = 0;

  while (startIndex < source.length) {
    const matchIndex = lowerSource.indexOf(lowerQuery, startIndex);
    if (matchIndex === -1) break;
    const end = matchIndex + normalizedQuery.length;
    ranges.push({ start: matchIndex, end });
    startIndex = end;
  }

  return ranges;
};

export const attachDataGridFindRenderVersion = <T>(rows: T[], query: string): T[] => {
  const normalizedQuery = normalizeDataGridFindQuery(query);
  if (!normalizedQuery) return rows;

  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const nextRow = { ...(row as object) } as T;
    Object.defineProperty(nextRow, DATA_GRID_FIND_RENDER_VERSION, {
      value: normalizedQuery,
      enumerable: true,
    });
    return nextRow;
  });
};

export const hasDataGridFindRenderVersionChanged = (nextRecord: unknown, previousRecord: unknown): boolean => {
  const nextVersion = nextRecord && typeof nextRecord === 'object'
    ? (nextRecord as Record<symbol, unknown>)[DATA_GRID_FIND_RENDER_VERSION]
    : undefined;
  const previousVersion = previousRecord && typeof previousRecord === 'object'
    ? (previousRecord as Record<symbol, unknown>)[DATA_GRID_FIND_RENDER_VERSION]
    : undefined;
  return nextVersion !== previousVersion;
};

export const summarizeDataGridFindMatches = <T>(
  rows: T[],
  columnNames: string[],
  query: string,
  getCellText: (value: unknown, row: T, columnName: string) => string,
): DataGridFindSummary => {
  const normalizedQuery = normalizeDataGridFindQuery(query);
  if (!normalizedQuery) {
    return { matchedCellCount: 0, occurrenceCount: 0 };
  }

  let matchedCellCount = 0;
  let occurrenceCount = 0;

  rows.forEach((row) => {
    columnNames.forEach((columnName) => {
      const record = row as Record<string, unknown>;
      const ranges = findDataGridTextRanges(getCellText(record[columnName], row, columnName), normalizedQuery);
      if (ranges.length > 0) {
        matchedCellCount += 1;
        occurrenceCount += ranges.length;
      }
    });
  });

  return { matchedCellCount, occurrenceCount };
};

export const collectDataGridFindMatches = <T>(
  rows: T[],
  columnNames: string[],
  query: string,
  getCellText: (value: unknown, row: T, columnName: string) => string,
  getRowKey: (row: T, rowIndex: number) => string,
): DataGridFindMatch[] => collectDataGridFindResult(
  rows,
  columnNames,
  query,
  getCellText,
  getRowKey,
).matches;

export const collectDataGridFindResult = <T>(
  rows: T[],
  columnNames: string[],
  query: string,
  getCellText: (value: unknown, row: T, columnName: string) => string,
  getRowKey: (row: T, rowIndex: number) => string,
): DataGridFindResult => {
  const normalizedQuery = normalizeDataGridFindQuery(query);
  if (!normalizedQuery) {
    return {
      matches: [],
      summary: { matchedCellCount: 0, occurrenceCount: 0 },
    };
  }

  const matches: DataGridFindMatch[] = [];
  let matchedCellCount = 0;

  rows.forEach((row, rowIndex) => {
    const record = row as Record<string, unknown>;
    const rowKey = getRowKey(row, rowIndex);
    columnNames.forEach((columnName, columnIndex) => {
      const ranges = findDataGridTextRanges(getCellText(record[columnName], row, columnName), normalizedQuery);
      if (ranges.length > 0) {
        matchedCellCount += 1;
      }
      ranges.forEach((range, occurrenceIndex) => {
        matches.push({
          rowIndex,
          rowKey,
          columnName,
          columnIndex,
          occurrenceIndex,
          start: range.start,
          end: range.end,
        });
      });
    });
  });

  return {
    matches,
    summary: {
      matchedCellCount,
      occurrenceCount: matches.length,
    },
  };
};

export const resolveDataGridFindNavigationIndex = (
  currentIndex: number,
  matchCount: number,
  direction: DataGridFindNavigationDirection,
): number => {
  if (matchCount <= 0) return -1;
  if (direction === 'previous') {
    return currentIndex <= 0 ? matchCount - 1 : currentIndex - 1;
  }
  return currentIndex < 0 || currentIndex >= matchCount - 1 ? 0 : currentIndex + 1;
};

export const matchesDataGridColumnQuickFind = (
  columnName: string,
  query: string,
): boolean => {
  const normalizedQuery = normalizeDataGridFindQuery(query).toLocaleLowerCase();
  if (!normalizedQuery) return false;

  return normalizeDataGridFindQuery(columnName).toLocaleLowerCase().includes(normalizedQuery);
};

export const resolveDataGridColumnQuickFindTarget = (
  columnNames: string[],
  query: string,
): string => {
  const normalizedQuery = normalizeDataGridFindQuery(query);
  if (!normalizedQuery) return '';

  const lowerQuery = normalizedQuery.toLocaleLowerCase();
  const exactMatch = columnNames.find((columnName) => (
    normalizeDataGridFindQuery(columnName).toLocaleLowerCase() === lowerQuery
  ));
  if (exactMatch) return exactMatch;

  return columnNames.find((columnName) => (
    matchesDataGridColumnQuickFind(columnName, normalizedQuery)
  )) || '';
};
