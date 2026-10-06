import { useCallback, useEffect, useMemo, useState, type Key } from 'react';
import {
  RESULT_CHART_MAX_SERIES,
  RESULT_CHART_SPLIT_TYPES,
  buildResultChartData,
  inferResultChartColumns,
  resolveResultChartSelection,
  sanitizeResultChartConfig,
  suggestResultChartConfig,
  type ResultChartAggregate,
  type ResultChartColumn,
  type ResultChartConfig,
  type ResultChartData,
  type ResultChartRow,
  type ResultChartSelectionScope,
  type ResultChartType,
} from './resultChartModel';
import { RESULT_CHART_SCATTER_MAX_SERIES } from './resultChartPalette';

type ColumnMetaLike = { type?: string };

export interface UseResultChartStateOptions {
  rows: ResultChartRow[];
  columns: string[];
  columnMetaMap?: Record<string, ColumnMetaLike>;
  columnMetaMapByLowerName?: Record<string, ColumnMetaLike>;
  selectedRowKeys?: readonly Key[];
  selectedCells?: ReadonlySet<string>;
}

export interface ResultChartState {
  /** The current selection, when it is big enough to chart on its own. */
  selection: ResultChartSelectionScope | null;
  selectionOnly: boolean;
  setSelectionOnly: (value: boolean) => void;
  rowCount: number;
  columns: ResultChartColumn[];
  config: ResultChartConfig | null;
  data: ResultChartData | null;
  setType: (type: ResultChartType) => void;
  setX: (x: string) => void;
  setYs: (ys: string[]) => void;
  setAggregate: (aggregate: ResultChartAggregate) => void;
  setSplitBy: (splitBy: string | undefined) => void;
}

const firstMeasure = (columns: ResultChartColumn[], except: string[] = []): ResultChartColumn | undefined => (
  columns.find((column) => column.kind === 'number' && !column.identifier && !except.includes(column.name))
  ?? columns.find((column) => column.kind === 'number' && !except.includes(column.name))
);

const maxMeasures = (config: ResultChartConfig): number => {
  if (config.type === 'scatter') return RESULT_CHART_SCATTER_MAX_SERIES;
  if (config.type === 'pie' || config.splitBy) return 1;
  return RESULT_CHART_MAX_SERIES;
};

/** Keep a configuration coherent with the chart type it is switched to. */
const adaptConfigToType = (
  config: ResultChartConfig,
  type: ResultChartType,
  columns: ResultChartColumn[],
): ResultChartConfig => {
  const next: ResultChartConfig = {
    ...config,
    type,
    splitBy: RESULT_CHART_SPLIT_TYPES.includes(type) ? config.splitBy : undefined,
  };
  if (type === 'histogram') {
    const measure = columns.find((column) => column.name === config.x && column.kind === 'number')
      ?? firstMeasure(columns);
    return measure ? { ...next, x: measure.name, ys: [], aggregate: 'count' } : next;
  }
  if (config.type === 'histogram') {
    // Leaving a distribution: chart the measure against the first other column.
    const other = columns.find((column) => column.name !== config.x);
    return other ? { ...next, x: other.name, ys: [config.x], aggregate: 'none' } : next;
  }
  if (type === 'scatter') {
    const xIsNumber = columns.some((column) => column.name === config.x && column.kind === 'number');
    const x = xIsNumber ? config.x : (firstMeasure(columns, config.ys)?.name ?? config.x);
    return { ...next, x, ys: config.ys.filter((y) => y !== x).slice(0, RESULT_CHART_SCATTER_MAX_SERIES), aggregate: 'none' };
  }
  if (type === 'pie') return { ...next, ys: config.ys.slice(0, 1) };
  return next;
};

export const useResultChartState = ({
  rows,
  columns,
  columnMetaMap,
  columnMetaMapByLowerName,
  selectedRowKeys,
  selectedCells,
}: UseResultChartStateOptions): ResultChartState => {
  const selection = useMemo(
    () => resolveResultChartSelection(rows, columns, selectedRowKeys, selectedCells),
    [columns, rows, selectedCells, selectedRowKeys],
  );
  const [selectionOnly, setSelectionOnly] = useState(true);
  const scoped = selectionOnly && selection !== null;
  const chartRows = scoped ? selection.rows : rows;
  const chartColumnNames = scoped && selection.columns.length > 0 ? selection.columns : columns;

  const inferred = useMemo(() => inferResultChartColumns(
    chartRows,
    chartColumnNames,
    (name) => columnMetaMap?.[name] ?? columnMetaMapByLowerName?.[name.toLowerCase()],
  ), [chartColumnNames, chartRows, columnMetaMap, columnMetaMapByLowerName]);
  const suggestion = useMemo(() => suggestResultChartConfig(inferred), [inferred]);

  // A different set of columns (new query, new selection) restarts from the
  // suggestion; refreshed rows of the same result keep the user's choices.
  const [override, setOverride] = useState<ResultChartConfig | null>(null);
  const columnSignature = chartColumnNames.join('\u0000');
  useEffect(() => setOverride(null), [columnSignature]);

  const config = (override && sanitizeResultChartConfig(override, inferred)) || suggestion;
  const data = useMemo(
    () => (config ? buildResultChartData(chartRows, inferred, config) : null),
    [chartRows, config, inferred],
  );

  // Functional so that two changes in one tick both apply to the latest config.
  const update = useCallback((change: (current: ResultChartConfig) => ResultChartConfig) => {
    setOverride((previous) => {
      const current = (previous && sanitizeResultChartConfig(previous, inferred)) || suggestion;
      return current ? change(current) : previous;
    });
  }, [inferred, suggestion]);

  return {
    selection,
    selectionOnly,
    setSelectionOnly,
    rowCount: chartRows.length,
    columns: inferred,
    config,
    data,
    setType: (type) => update((current) => adaptConfigToType(current, type, inferred)),
    setX: (x) => update((current) => ({
      ...current,
      x,
      ys: current.ys.filter((y) => y !== x),
      splitBy: current.splitBy === x ? undefined : current.splitBy,
    })),
    setYs: (ys) => update((current) => ({ ...current, ys: ys.slice(0, maxMeasures(current)) })),
    setAggregate: (aggregate) => update((current) => ({ ...current, aggregate })),
    // A split draws one series per group, so it charts a single measure.
    setSplitBy: (splitBy) => update((current) => ({ ...current, splitBy, ys: splitBy ? current.ys.slice(0, 1) : current.ys })),
  };
};
