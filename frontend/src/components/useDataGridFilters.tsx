import React from 'react';
import type { FilterCondition, FilterValueSelection } from '../utils/sql';
import { applyNoAutoCapAttributesWithin } from '../utils/inputAutoCap';
import {
  normalizeQuickWhereCondition,
  resolveWhereConditionSuggestions,
  validateQuickWhereCondition,
} from '../utils/dataGridWhereFilter';

export type GridFilterConditionState = FilterCondition & {
  id: number;
  column: string;
  op: string;
  value: string;
  value2?: string;
};

export type GridColumnFilterDraft = {
  column: string;
  op: string;
  value?: string;
  value2?: string;
  valueSelection?: FilterValueSelection;
};

type GridSortInfo = {
  columnKey: string;
  order: string;
  enabled?: boolean;
};

interface UseDataGridFiltersParams {
  appliedFilterConditions?: FilterCondition[];
  quickWhereCondition?: string;
  showFilter?: boolean;
  displayColumnNames: string[];
  allTableColumnNames: string[];
  columnMetaMap: Record<string, unknown>;
  dbType: string;
  darkMode: boolean;
  onApplyFilter?: (conditions: GridFilterConditionState[]) => void;
  onApplyQuickWhereCondition?: (condition: string) => void;
  onSort?: (field: string, order: string) => void;
  messageApi?: {
    warning?: (content: string) => void;
  };
  translate?: (key: string, params?: Record<string, string | number>) => string;
  getColumnFilterType: (columnName: string) => string;
  resolveDefaultGridFilterOperator: (columnType: unknown) => string;
  resolveNextGridFilterOperatorForColumnChange: (params: {
    currentOperator: unknown;
    previousColumnType: unknown;
    nextColumnType: unknown;
  }) => string;
}

export interface UseDataGridFiltersResult {
  filterConditions: GridFilterConditionState[];
  setFilterConditions: React.Dispatch<React.SetStateAction<GridFilterConditionState[]>>;
  quickWhereDraft: string;
  setQuickWhereDraft: React.Dispatch<React.SetStateAction<string>>;
  quickWhereSuggestionsOpen: boolean;
  setQuickWhereSuggestionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filterPanelRef: React.RefObject<HTMLDivElement>;
  filterOpOptions: Array<{ value: string; label: string }>;
  filterLogicOptions: Array<{ value: string; label: string }>;
  quickWhereSuggestionOptions: Array<{ value: string; insertText: string; suggestionKind: string; label: React.ReactNode }>;
  handleQuickWherePaste: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  stopQuickWhereClipboardPropagation: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  isNoValueOp: (op: string) => boolean;
  isBetweenOp: (op: string) => boolean;
  isListOp: (op: string) => boolean;
  addFilter: () => void;
  updateFilter: (id: number, field: keyof GridFilterConditionState, val: string | boolean) => void;
  removeFilter: (id: number) => void;
  applyColumnFilter: (draft: GridColumnFilterDraft) => boolean;
  clearColumnFilter: (columnName: string) => boolean;
  applyQuickWhereCondition: (condition?: string) => boolean;
  clearQuickWhereCondition: () => void;
  clearAllFiltersAndSorts: () => void;
  applyFilters: () => void;
  applyAllFiltersEnabled: () => void;
  applyAllFiltersDisabled: () => void;
}

const EXACT_GRID_FILTER_OPERATOR = '=';
const fallbackTranslate = (key: string) => key;

export const useDataGridFilters = ({
  appliedFilterConditions,
  quickWhereCondition,
  showFilter,
  displayColumnNames,
  allTableColumnNames,
  columnMetaMap,
  dbType,
  darkMode,
  onApplyFilter,
  onApplyQuickWhereCondition,
  onSort,
  messageApi,
  translate = fallbackTranslate,
  getColumnFilterType,
  resolveDefaultGridFilterOperator,
  resolveNextGridFilterOperatorForColumnChange,
}: UseDataGridFiltersParams): UseDataGridFiltersResult => {
  const normalizeFilterLogic = React.useCallback((logic: unknown): 'AND' | 'OR' => {
    return String(logic || '').trim().toUpperCase() === 'OR' ? 'OR' : 'AND';
  }, []);

  const firstColumnNameRef = React.useRef(displayColumnNames[0] || '');
  firstColumnNameRef.current = displayColumnNames[0] || '';

  const normalizeGridFilterConditions = React.useCallback((conditions?: FilterCondition[]): GridFilterConditionState[] => {
    if (!Array.isArray(conditions)) return [];
    return conditions.map((cond, index) => {
      const fallbackId = index + 1;
      const nextId = Number.isFinite(Number(cond?.id)) ? Number(cond?.id) : fallbackId;
      const op = String(cond?.op || EXACT_GRID_FILTER_OPERATOR);
      const rawColumn = String(cond?.column || '');
      return {
        id: nextId,
        enabled: cond?.enabled !== false,
        logic: normalizeFilterLogic(cond?.logic),
        column: rawColumn || (op === 'CUSTOM' ? '' : String(firstColumnNameRef.current || '')),
        op,
        value: String(cond?.value ?? ''),
        value2: String(cond?.value2 ?? ''),
        valueSelection: cond?.valueSelection ? {
          values: Array.from(new Set((cond.valueSelection.values || []).map((value) => String(value)))),
          ...(cond.valueSelection.includeNull ? { includeNull: true } : {}),
          ...(cond.valueSelection.includeEmpty ? { includeEmpty: true } : {}),
        } : undefined,
      };
    });
  }, [normalizeFilterLogic]);

  const [filterConditions, setFilterConditions] = React.useState<GridFilterConditionState[]>([]);
  const [nextFilterId, setNextFilterId] = React.useState(1);
  const [quickWhereDraft, setQuickWhereDraft] = React.useState(() => normalizeQuickWhereCondition(quickWhereCondition));
  const [quickWhereSuggestionsOpen, setQuickWhereSuggestionsOpen] = React.useState(false);
  const filterPanelRef = React.useRef<HTMLDivElement>(null);
  const autoDefaultFilterIdsRef = React.useRef<Set<number>>(new Set());

  React.useEffect(() => {
    const nextConditions = normalizeGridFilterConditions(appliedFilterConditions);
    autoDefaultFilterIdsRef.current.clear();
    setFilterConditions(nextConditions);
    const maxId = nextConditions.reduce((max, cond) => (cond.id > max ? cond.id : max), 0);
    setNextFilterId(Math.max(1, maxId + 1));
  }, [appliedFilterConditions, normalizeGridFilterConditions]);

  React.useEffect(() => {
    setQuickWhereDraft(normalizeQuickWhereCondition(quickWhereCondition));
  }, [quickWhereCondition]);

  React.useEffect(() => {
    if (Object.keys(columnMetaMap).length === 0) return;
    setFilterConditions((prev) => {
      let changed = false;
      const nextConditions = prev.map((cond) => {
        if (!autoDefaultFilterIdsRef.current.has(cond.id)) {
          return cond;
        }
        const nextOp = resolveDefaultGridFilterOperator(getColumnFilterType(cond.column));
        if (nextOp === cond.op) return cond;
        changed = true;
        return { ...cond, op: nextOp };
      });
      return changed ? nextConditions : prev;
    });
  }, [columnMetaMap, getColumnFilterType, resolveDefaultGridFilterOperator]);

  const quickWhereSuggestionOptions = React.useMemo(() => {
    const columnSuggestionSource = allTableColumnNames.length > 0 ? allTableColumnNames : displayColumnNames;
    return resolveWhereConditionSuggestions({
      input: quickWhereDraft,
      columnNames: columnSuggestionSource,
      dbType,
    }).map((item) => ({
      value: item.value,
      insertText: item.insertText,
      suggestionKind: item.kind,
      label: (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span>{item.label}</span>
          <span style={{ color: darkMode ? 'rgba(255,255,255,0.46)' : 'rgba(0,0,0,0.42)', fontSize: 12 }}>{item.detail}</span>
        </div>
      ),
    }));
  }, [allTableColumnNames, displayColumnNames, quickWhereDraft, dbType, darkMode]);

  const handleQuickWherePaste = React.useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
    const pastedText = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
    if (!pastedText) return;

    event.preventDefault();
    event.stopPropagation();

    const input = event.currentTarget;
    const currentValue = input.value ?? quickWhereDraft;
    const start = input.selectionStart ?? currentValue.length;
    const end = input.selectionEnd ?? start;
    const nextValue = `${currentValue.slice(0, start)}${pastedText}${currentValue.slice(end)}`;
    const nextCursor = start + pastedText.length;

    setQuickWhereDraft(nextValue);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }, [quickWhereDraft]);

  const stopQuickWhereClipboardPropagation = React.useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  React.useEffect(() => {
    if (!showFilter) {
      return;
    }
    const root = filterPanelRef.current;
    if (!root) {
      return;
    }
    const apply = () => {
      applyNoAutoCapAttributesWithin(root);
    };
    apply();
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(() => {
      apply();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [showFilter]);

  const filterOpOptions = React.useMemo(() => ([
    { value: '=', label: '=' },
    { value: '!=', label: '!=' },
    { value: '<', label: '<' },
    { value: '<=', label: '<=' },
    { value: '>', label: '>' },
    { value: '>=', label: '>=' },
    { value: 'CONTAINS', label: translate('data_grid.filter.op.contains') },
    { value: 'NOT_CONTAINS', label: translate('data_grid.filter.op.not_contains') },
    { value: 'STARTS_WITH', label: translate('data_grid.filter.op.starts_with') },
    { value: 'NOT_STARTS_WITH', label: translate('data_grid.filter.op.not_starts_with') },
    { value: 'ENDS_WITH', label: translate('data_grid.filter.op.ends_with') },
    { value: 'NOT_ENDS_WITH', label: translate('data_grid.filter.op.not_ends_with') },
    { value: 'IS_NULL', label: translate('data_grid.filter.op.is_null') },
    { value: 'IS_NOT_NULL', label: translate('data_grid.filter.op.is_not_null') },
    { value: 'IS_EMPTY', label: translate('data_grid.filter.op.is_empty') },
    { value: 'IS_NOT_EMPTY', label: translate('data_grid.filter.op.is_not_empty') },
    { value: 'BETWEEN', label: translate('data_grid.filter.op.between') },
    { value: 'NOT_BETWEEN', label: translate('data_grid.filter.op.not_between') },
    { value: 'IN', label: translate('data_grid.filter.op.in_list') },
    { value: 'NOT_IN', label: translate('data_grid.filter.op.not_in_list') },
    { value: 'CUSTOM', label: translate('data_grid.filter.op.custom') },
  ]), [translate]);

  const filterLogicOptions = React.useMemo(() => ([
    { value: 'AND', label: translate('data_grid.filter.logic.and') },
    { value: 'OR', label: translate('data_grid.filter.logic.or') },
  ]), [translate]);

  const isNoValueOp = React.useCallback((op: string) => (
    op === 'IS_NULL' || op === 'IS_NOT_NULL' || op === 'IS_EMPTY' || op === 'IS_NOT_EMPTY'
  ), []);
  const isBetweenOp = React.useCallback((op: string) => op === 'BETWEEN' || op === 'NOT_BETWEEN', []);
  const isListOp = React.useCallback((op: string) => op === 'IN' || op === 'NOT_IN', []);

  const addFilter = React.useCallback(() => {
    const column = displayColumnNames[0] || '';
    const id = nextFilterId;
    autoDefaultFilterIdsRef.current.add(id);
    setFilterConditions((prev) => [
      ...prev,
      {
        id,
        enabled: true,
        logic: 'AND',
        column,
        op: resolveDefaultGridFilterOperator(getColumnFilterType(column)),
        value: '',
        value2: '',
      },
    ]);
    setNextFilterId((prev) => prev + 1);
  }, [displayColumnNames, getColumnFilterType, nextFilterId, resolveDefaultGridFilterOperator]);

  const updateFilter = React.useCallback((id: number, field: keyof GridFilterConditionState, val: string | boolean) => {
    setFilterConditions((prev) => prev.map((cond) => {
      if (cond.id !== id) return cond;
      const next: GridFilterConditionState = { ...cond, [field]: val } as GridFilterConditionState;
      if (field === 'column') {
        next.op = resolveNextGridFilterOperatorForColumnChange({
          currentOperator: cond.op,
          previousColumnType: getColumnFilterType(cond.column),
          nextColumnType: getColumnFilterType(String(val)),
        });
        if (isNoValueOp(next.op)) {
          next.value = '';
          next.value2 = '';
        } else if (!isBetweenOp(next.op)) {
          next.value2 = '';
        }
      }
      if (field === 'op') {
        autoDefaultFilterIdsRef.current.delete(id);
        const nextOp = String(val);
        if (isNoValueOp(nextOp)) {
          next.value = '';
          next.value2 = '';
        } else if (isBetweenOp(nextOp)) {
          if (typeof next.value2 !== 'string') next.value2 = '';
        } else {
          next.value2 = '';
        }
      }
      return next;
    }));
  }, [getColumnFilterType, isBetweenOp, isNoValueOp, resolveNextGridFilterOperatorForColumnChange]);

  const removeFilter = React.useCallback((id: number) => {
    autoDefaultFilterIdsRef.current.delete(id);
    setFilterConditions((prev) => prev.filter((cond) => cond.id !== id));
  }, []);

  const applyQuickWhereCondition = React.useCallback((condition: string = quickWhereDraft): boolean => {
    const normalized = normalizeQuickWhereCondition(condition);
    const validation = validateQuickWhereCondition(normalized);
    if (!validation.ok) {
      messageApi?.warning?.(validation.message);
      return false;
    }
    setQuickWhereDraft(normalized);
    if (onApplyQuickWhereCondition) onApplyQuickWhereCondition(normalized);
    return true;
  }, [messageApi, onApplyQuickWhereCondition, quickWhereDraft]);

  const clearQuickWhereCondition = React.useCallback(() => {
    setQuickWhereDraft('');
    if (onApplyQuickWhereCondition) onApplyQuickWhereCondition('');
  }, [onApplyQuickWhereCondition]);

  const clearAllFiltersAndSorts = React.useCallback(() => {
    setFilterConditions([]);
    clearQuickWhereCondition();
    if (onApplyFilter) onApplyFilter([]);
    if (onSort) onSort('', '');
  }, [clearQuickWhereCondition, onApplyFilter, onSort]);

  const applyFilters = React.useCallback(() => {
    if (!applyQuickWhereCondition()) return;
    if (onApplyFilter) onApplyFilter(filterConditions);
  }, [applyQuickWhereCondition, filterConditions, onApplyFilter]);

  const applyColumnFilter = React.useCallback((draft: GridColumnFilterDraft): boolean => {
    const column = String(draft?.column || '').trim();
    if (!column) return false;
    if (!applyQuickWhereCondition()) return false;

    const existingColumnConditions = filterConditions.filter((cond) => (
      String(cond?.column || '') === column && String(cond?.op || '') !== 'CUSTOM'
    ));
    const existingPrimary = existingColumnConditions[0];
    const op = String(draft?.op || resolveDefaultGridFilterOperator(getColumnFilterType(column))).trim();
    const id = Number.isFinite(Number(existingPrimary?.id)) ? Number(existingPrimary?.id) : nextFilterId;
    existingColumnConditions.forEach((cond) => {
      autoDefaultFilterIdsRef.current.delete(cond.id);
    });
    autoDefaultFilterIdsRef.current.delete(id);

    const nextCondition: GridFilterConditionState = {
      id,
      enabled: true,
      logic: normalizeFilterLogic(existingPrimary?.logic),
      column,
      op,
      value: isNoValueOp(op) ? '' : String(draft?.value ?? ''),
      value2: isNoValueOp(op) || !isBetweenOp(op) ? '' : String(draft?.value2 ?? ''),
      valueSelection: draft.valueSelection,
    };
    const nextConditions = [
      ...filterConditions.filter((cond) => !(
        String(cond?.column || '') === column && String(cond?.op || '') !== 'CUSTOM'
      )),
      nextCondition,
    ];

    setFilterConditions(nextConditions);
    if (!existingPrimary) {
      setNextFilterId((prev) => Math.max(prev, id + 1));
    }
    if (onApplyFilter) onApplyFilter(nextConditions);
    return true;
  }, [
    applyQuickWhereCondition,
    filterConditions,
    getColumnFilterType,
    isBetweenOp,
    isNoValueOp,
    nextFilterId,
    normalizeFilterLogic,
    onApplyFilter,
    resolveDefaultGridFilterOperator,
  ]);

  const clearColumnFilter = React.useCallback((columnName: string): boolean => {
    const column = String(columnName || '').trim();
    if (!column) return false;

    const nextConditions = filterConditions.filter((cond) => !(
      String(cond?.column || '') === column && String(cond?.op || '') !== 'CUSTOM'
    ));
    if (nextConditions.length === filterConditions.length) return true;
    if (!applyQuickWhereCondition()) return false;

    filterConditions.forEach((cond) => {
      if (String(cond?.column || '') === column && String(cond?.op || '') !== 'CUSTOM') {
        autoDefaultFilterIdsRef.current.delete(cond.id);
      }
    });
    setFilterConditions(nextConditions);
    if (onApplyFilter) onApplyFilter(nextConditions);
    return true;
  }, [applyQuickWhereCondition, filterConditions, onApplyFilter]);

  const applyAllFiltersEnabled = React.useCallback(() => {
    setFilterConditions((prev) => prev.map((cond) => ({ ...cond, enabled: true })));
  }, []);

  const applyAllFiltersDisabled = React.useCallback(() => {
    setFilterConditions((prev) => prev.map((cond) => ({ ...cond, enabled: false })));
  }, []);

  return {
    filterConditions,
    setFilterConditions,
    quickWhereDraft,
    setQuickWhereDraft,
    quickWhereSuggestionsOpen,
    setQuickWhereSuggestionsOpen,
    filterPanelRef,
    filterOpOptions,
    filterLogicOptions,
    quickWhereSuggestionOptions,
    handleQuickWherePaste,
    stopQuickWhereClipboardPropagation,
    isNoValueOp,
    isBetweenOp,
    isListOp,
    addFilter,
    updateFilter,
    removeFilter,
    applyColumnFilter,
    clearColumnFilter,
    applyQuickWhereCondition,
    clearQuickWhereCondition,
    clearAllFiltersAndSorts,
    applyFilters,
    applyAllFiltersEnabled,
    applyAllFiltersDisabled,
  };
};
