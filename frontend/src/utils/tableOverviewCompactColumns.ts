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
