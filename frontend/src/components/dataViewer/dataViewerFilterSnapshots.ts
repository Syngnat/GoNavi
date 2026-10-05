import { TabData } from '../../types';
import type { FilterCondition } from '../../utils/sql';
import { normalizeQuickWhereCondition } from '../../utils/dataGridWhereFilter';

export type ViewerFilterSnapshot = {
  showFilter: boolean;
  conditions: FilterCondition[];
  quickWhereCondition: string;
  currentPage: number;
  pageSize: number;
  sortInfo: Array<{ columnKey: string, order: string, enabled?: boolean }>;
  scrollTop: number;
  scrollLeft: number;
};

export type ViewerScrollSnapshot = {
  top: number;
  left: number;
};

const viewerFilterSnapshotsByTab = new Map<string, ViewerFilterSnapshot>();
const MAX_VIEWER_FILTER_SNAPSHOTS = 64;
export const VIEWER_SCROLL_SNAPSHOT_PERSIST_DELAY_MS = 160;
export const shouldDeferInitialDataViewerFetch = (initialViewMode?: TabData['initialViewMode']): boolean => (
  initialViewMode === 'fields'
);

const trimViewerFilterSnapshots = () => {
  while (viewerFilterSnapshotsByTab.size > MAX_VIEWER_FILTER_SNAPSHOTS) {
    const oldestKey = viewerFilterSnapshotsByTab.keys().next().value;
    if (!oldestKey) {
      break;
    }
    viewerFilterSnapshotsByTab.delete(oldestKey);
  }
};

export const setViewerFilterSnapshot = (
  tabId: string,
  snapshot: ViewerFilterSnapshot,
) => {
  const normalizedTabId = String(tabId || '').trim();
  if (!normalizedTabId) return;
  if (viewerFilterSnapshotsByTab.has(normalizedTabId)) {
    viewerFilterSnapshotsByTab.delete(normalizedTabId);
  }
  viewerFilterSnapshotsByTab.set(normalizedTabId, snapshot);
  trimViewerFilterSnapshots();
};

export const normalizeViewerFilterConditions = (conditions: FilterCondition[] | undefined): FilterCondition[] => {
  if (!Array.isArray(conditions)) return [];
  return conditions.map((cond) => ({
    id: Number.isFinite(Number(cond?.id)) ? Number(cond?.id) : undefined,
    enabled: cond?.enabled !== false,
    logic: String(cond?.logic || '').trim().toUpperCase() === 'OR' ? 'OR' : 'AND',
    column: String(cond?.column || ''),
    op: String(cond?.op || '='),
    value: String(cond?.value ?? ''),
    value2: String(cond?.value2 ?? ''),
    valueSelection: cond?.valueSelection ? {
      values: Array.from(new Set((cond.valueSelection.values || []).map((value) => String(value)))),
      ...(cond.valueSelection.includeNull ? { includeNull: true } : {}),
      ...(cond.valueSelection.includeEmpty ? { includeEmpty: true } : {}),
    } : undefined,
  }));
};

export const getViewerFilterSnapshot = (tabId: string): ViewerFilterSnapshot => {
  const cached = viewerFilterSnapshotsByTab.get(String(tabId || '').trim());
  if (!cached) {
    return { showFilter: false, conditions: [], quickWhereCondition: '', currentPage: 1, pageSize: 100, sortInfo: [], scrollTop: 0, scrollLeft: 0 };
  }
  return {
    showFilter: cached.showFilter === true,
    conditions: normalizeViewerFilterConditions(cached.conditions),
    quickWhereCondition: normalizeQuickWhereCondition(cached.quickWhereCondition),
    currentPage: Number.isFinite(Number(cached.currentPage)) && Number(cached.currentPage) > 0 ? Number(cached.currentPage) : 1,
    pageSize: Number.isFinite(Number(cached.pageSize)) && Number(cached.pageSize) > 0 ? Number(cached.pageSize) : 100,
    sortInfo: Array.isArray(cached.sortInfo)
      ? cached.sortInfo.filter(s => s && s.columnKey && (s.order === 'ascend' || s.order === 'descend'))
          .map(s => ({ columnKey: String(s.columnKey), order: s.order }))
      : (cached.sortInfo && (cached.sortInfo as any).columnKey ? [{ columnKey: String((cached.sortInfo as any).columnKey), order: (cached.sortInfo as any).order }] : []),
    scrollTop: Number.isFinite(Number(cached.scrollTop)) ? Number(cached.scrollTop) : 0,
    scrollLeft: Number.isFinite(Number(cached.scrollLeft)) ? Number(cached.scrollLeft) : 0,
  };
};
