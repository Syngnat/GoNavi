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

export type DataGridColumnCommentLookup = (columnName: string) => string;

export type DataGridColumnQuickFindMatchTier =
  | 'name-exact'
  | 'comment-exact'
  | 'name-substring'
  | 'comment-substring';

const DATA_GRID_COLUMN_QUICK_FIND_TIER_RANK: Record<DataGridColumnQuickFindMatchTier, number> = {
  'name-exact': 0,
  'comment-exact': 1,
  'name-substring': 2,
  'comment-substring': 3,
};

const normalizeDataGridQuickFindLower = (value: unknown): string => (
  normalizeDataGridFindQuery(value).toLocaleLowerCase()
);

// 命中层级即跳列优先级：列名精确 > 注释精确 > 列名子串 > 注释子串。
// 未提供注释查找时退化为原有的两级列名匹配，保持既有行为不变。
export const resolveDataGridColumnQuickFindMatchTier = (
  columnName: string,
  query: string,
  getColumnComment?: DataGridColumnCommentLookup,
): DataGridColumnQuickFindMatchTier | undefined => {
  const normalizedQuery = normalizeDataGridQuickFindLower(query);
  if (!normalizedQuery) return undefined;

  const lowerName = normalizeDataGridQuickFindLower(columnName);
  if (lowerName === normalizedQuery) return 'name-exact';
  const lowerComment = getColumnComment
    ? normalizeDataGridQuickFindLower(getColumnComment(columnName))
    : '';
  if (lowerComment && lowerComment === normalizedQuery) return 'comment-exact';
  if (lowerName.includes(normalizedQuery)) return 'name-substring';
  if (lowerComment && lowerComment.includes(normalizedQuery)) return 'comment-substring';
  return undefined;
};

export const rankDataGridColumnQuickFindMatchTier = (
  tier: DataGridColumnQuickFindMatchTier,
): number => DATA_GRID_COLUMN_QUICK_FIND_TIER_RANK[tier];

export const matchesDataGridColumnQuickFind = (
  columnName: string,
  query: string,
  getColumnComment?: DataGridColumnCommentLookup,
): boolean => (
  resolveDataGridColumnQuickFindMatchTier(columnName, query, getColumnComment) !== undefined
);

export const resolveDataGridColumnQuickFindTarget = (
  columnNames: string[],
  query: string,
  getColumnComment?: DataGridColumnCommentLookup,
): string => {
  const normalizedQuery = normalizeDataGridFindQuery(query);
  if (!normalizedQuery) return '';

  let target = '';
  let targetRank = Number.POSITIVE_INFINITY;
  columnNames.forEach((columnName) => {
    const tier = resolveDataGridColumnQuickFindMatchTier(columnName, normalizedQuery, getColumnComment);
    if (!tier) return;
    const rank = DATA_GRID_COLUMN_QUICK_FIND_TIER_RANK[tier];
    if (rank < targetRank) {
      targetRank = rank;
      target = columnName;
    }
  });
  return target;
};
