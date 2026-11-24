export const TABLE_OVERVIEW_COMPACT_COLUMN_KEYS = [
  'name',
  'comment',
  'rows',
  'dataSize',
  'indexSize',
  'engine',
  'charset',
  'collation',
  'updateTime',
  'createTime',
] as const;

export type TableOverviewCompactColumn =
  (typeof TABLE_OVERVIEW_COMPACT_COLUMN_KEYS)[number];

export type TableOverviewCompactColumnWidths =
  Partial<Record<TableOverviewCompactColumn, number>>;

export const TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MIN = 64;
export const TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX = 2000;

export const DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS: TableOverviewCompactColumn[] = [
  ...TABLE_OVERVIEW_COMPACT_COLUMN_KEYS,
];

const tableOverviewCompactColumnSet = new Set<TableOverviewCompactColumn>(
  TABLE_OVERVIEW_COMPACT_COLUMN_KEYS,
);

export const isTableOverviewCompactColumn = (
  value: unknown,
): value is TableOverviewCompactColumn => (
  typeof value === 'string'
  && tableOverviewCompactColumnSet.has(value as TableOverviewCompactColumn)
);

export const sanitizeTableOverviewCompactColumns = (
  value: unknown,
): TableOverviewCompactColumn[] => {
  if (!Array.isArray(value)) {
    return [...DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS];
  }
  const requested = new Set(value.filter(isTableOverviewCompactColumn));
  requested.add('name');
  return DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS.filter((key) => requested.has(key));
};

export const sanitizeTableOverviewCompactColumnWidths = (
  value: unknown,
): TableOverviewCompactColumnWidths => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const widths: TableOverviewCompactColumnWidths = {};
  TABLE_OVERVIEW_COMPACT_COLUMN_KEYS.forEach((key) => {
    const candidate = raw[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      return;
    }
    widths[key] = Math.round(Math.min(
      TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX,
      Math.max(TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MIN, candidate),
    ));
  });
  return widths;
};
