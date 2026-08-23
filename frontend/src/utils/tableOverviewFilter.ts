export const TABLE_OVERVIEW_RENDER_BATCH_SIZE = 300;

export type TableOverviewSortField =
  | 'name'
  | 'comment'
  | 'rows'
  | 'dataSize'
  | 'indexSize'
  | 'engine'
  | 'createTime'
  | 'updateTime';
export type TableOverviewSortOrder = 'asc' | 'desc';

export interface TableOverviewFilterRow {
  name: string;
  comment?: string;
  rows: number;
  dataSize: number;
  indexSize: number;
  engine?: string;
  createTime?: string;
  updateTime?: string;
}

export interface TableOverviewSearchIndexItem<T extends TableOverviewFilterRow> {
  row: T;
  searchText: string;
  sortName: string;
}

const compareTableNames = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });

export const buildTableOverviewSearchIndex = <T extends TableOverviewFilterRow>(
  rows: T[],
  getDisplayName: (row: T) => string = (row) => row.name,
): TableOverviewSearchIndexItem<T>[] => rows.map((row) => {
    const displayName = getDisplayName(row);
    return {
      row,
      searchText: `${displayName}\n${row.comment || ''}`.toLowerCase(),
      sortName: displayName.toLowerCase(),
    };
  });

export const filterAndSortTableOverviewRows = <T extends TableOverviewFilterRow>(
  indexedRows: TableOverviewSearchIndexItem<T>[],
  rawSearchText: string,
  sortField: TableOverviewSortField,
  sortOrder: TableOverviewSortOrder,
): T[] => {
  const keyword = String(rawSearchText || '').trim().toLowerCase();
  const matched = keyword
    ? indexedRows.filter((item) => item.searchText.includes(keyword))
    : [...indexedRows];

  matched.sort((a, b) => {
    if (sortField === 'name') {
      const cmp = compareTableNames(a.sortName, b.sortName);
      return sortOrder === 'asc' ? cmp : -cmp;
    }

    if (sortField === 'rows' || sortField === 'dataSize' || sortField === 'indexSize') {
      const left = a.row[sortField];
      const right = b.row[sortField];
      const leftUnknown = !Number.isFinite(left) || left < 0;
      const rightUnknown = !Number.isFinite(right) || right < 0;
      if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1;
      if (!leftUnknown && left !== right) {
        return sortOrder === 'asc' ? left - right : right - left;
      }
      return compareTableNames(a.sortName, b.sortName);
    }

    const left = String(a.row[sortField] || '').trim();
    const right = String(b.row[sortField] || '').trim();
    if (!left || !right) {
      if (!left && right) return 1;
      if (left && !right) return -1;
      return compareTableNames(a.sortName, b.sortName);
    }
    const cmp = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    if (cmp !== 0) return sortOrder === 'asc' ? cmp : -cmp;
    return compareTableNames(a.sortName, b.sortName);
  });

  return matched.map((item) => item.row);
};

export const resolveTableOverviewVisibleRows = <T>(
  rows: T[],
  rawLimit: number,
): { visibleRows: T[]; hiddenCount: number; totalCount: number } => {
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), rows.length)
    : Math.min(TABLE_OVERVIEW_RENDER_BATCH_SIZE, rows.length);
  return {
    visibleRows: rows.slice(0, limit),
    hiddenCount: Math.max(0, rows.length - limit),
    totalCount: rows.length,
  };
};

export const prioritizePinnedTableOverviewRows = <T>(
  rows: T[],
  isPinned: (row: T) => boolean,
): { orderedRows: T[]; pinnedRows: T[]; regularRows: T[] } => {
  const pinnedRows: T[] = [];
  const regularRows: T[] = [];

  rows.forEach((row) => {
    if (isPinned(row)) {
      pinnedRows.push(row);
    } else {
      regularRows.push(row);
    }
  });

  return {
    orderedRows: pinnedRows.length > 0 ? [...pinnedRows, ...regularRows] : [...rows],
    pinnedRows,
    regularRows,
  };
};
