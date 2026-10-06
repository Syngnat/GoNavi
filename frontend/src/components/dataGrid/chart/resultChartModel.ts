import { isNumericGridColumnType } from '../../dataGridColumnAlign';
import { isTemporalColumnType } from '../../dataGridTemporal';
import { GONAVI_ROW_KEY, splitCellKey } from '../core/dataGridCellKeys';
import { buildSplitResultChartData } from './resultChartSplit';
import {
  RESULT_CHART_COUNT_SERIES,
  RESULT_CHART_MAX_SERIES,
  RESULT_CHART_OTHER,
  RESULT_CHART_PIE_SLICES,
  RESULT_CHART_SPLIT_TYPES,
  RESULT_CHART_X_KEY,
  type ResultChartAggregate,
  type ResultChartColumn,
  type ResultChartColumnKind,
  type ResultChartConfig,
  type ResultChartData,
  type ResultChartRow,
  type ResultChartSeries,
} from './resultChartTypes';
import {
  accumulateChartValue,
  chartCategoryLabel,
  chartXValue,
  emptyChartAccumulator,
  finishChartValue,
  isEmptyChartValue,
  toChartNumber,
  toChartTime,
  type ChartAccumulator,
} from './resultChartValues';

export * from './resultChartTypes';
export { toChartNumber, toChartTime } from './resultChartValues';

const MAX_CATEGORY_POINTS = 500;
const MAX_SERIAL_POINTS = 5_000;
const INFERENCE_SAMPLE_ROWS = 300;
const KIND_SHARE_THRESHOLD = 0.8;
/** Measures sharing one value axis must stay within this factor of each other. */
const COMPARABLE_MAGNITUDE = 10;
const IDENTIFIER_PATTERN = /(^|[_\s-])id$|^id(_|$)|^(uuid|guid|pk)$/i;

type ColumnMetaLookup = (column: string) => { type?: string } | undefined;

export const inferResultChartColumns = (
  rows: ResultChartRow[],
  columns: string[],
  metaFor: ColumnMetaLookup = () => undefined,
): ResultChartColumn[] => {
  const sample = rows.slice(0, INFERENCE_SAMPLE_ROWS);
  return columns.map((name) => {
    let present = 0;
    let numbers = 0;
    let times = 0;
    let magnitude = 0;
    const distinct = new Set<string>();
    sample.forEach((row) => {
      const value = row?.[name];
      if (isEmptyChartValue(value)) return;
      present += 1;
      const number = toChartNumber(value);
      if (number !== null) {
        numbers += 1;
        magnitude = Math.max(magnitude, Math.abs(number));
      } else if (toChartTime(value) !== null) {
        times += 1;
      }
      if (distinct.size <= INFERENCE_SAMPLE_ROWS) distinct.add(chartCategoryLabel(value));
    });
    const declared = metaFor(name)?.type;
    const share = (count: number) => (present === 0 ? 0 : count / present);
    let kind: ResultChartColumnKind = 'category';
    if ((isTemporalColumnType(declared) && present > 0) || share(times) >= KIND_SHARE_THRESHOLD) kind = 'time';
    else if (present > 0 && share(numbers) >= KIND_SHARE_THRESHOLD) kind = 'number';
    else if (present === 0 && isNumericGridColumnType(declared)) kind = 'number';
    return {
      name,
      kind,
      distinct: distinct.size,
      filled: present,
      magnitude: kind === 'number' ? magnitude : 0,
      identifier: IDENTIFIER_PATTERN.test(name),
    };
  });
};

/** Measures that can share the first one's axis without being flattened against it. */
const comparableMeasures = (measures: ResultChartColumn[]): string[] => {
  const [first, ...rest] = measures;
  if (!first) return [];
  const base = Math.max(first.magnitude, Number.EPSILON);
  const fits = rest.filter((column) => {
    const ratio = column.magnitude / base;
    return ratio >= 1 / COMPARABLE_MAGNITUDE && ratio <= COMPARABLE_MAGNITUDE;
  });
  return [first, ...fits].slice(0, 3).map((column) => column.name);
};

/** Pick the chart a reader would most likely ask for, or null when nothing is chartable. */
export const suggestResultChartConfig = (columns: ResultChartColumn[]): ResultChartConfig | null => {
  const measures = columns.filter((column) => column.kind === 'number' && !column.identifier);
  const time = columns.find((column) => column.kind === 'time');
  const categories = columns.filter((column) => column.kind === 'category'
    || (column.kind === 'number' && column.identifier));
  // A grouping column with a few repeated values reads better than a unique key.
  const category = categories.find((column) => column.distinct > 1 && column.distinct <= 50) ?? categories[0];
  const ys = comparableMeasures(measures);
  // Repeated x values (raw rows rather than a GROUP BY result) are summed per x.
  const aggregateFor = (x: ResultChartColumn): ResultChartAggregate => (x.distinct < x.filled ? 'sum' : 'none');

  if (time && ys.length > 0) {
    // "day, region, amount": one line per region rather than a sum that hides them.
    const split = time.distinct < time.filled
      ? categories.find((column) => !column.identifier && column.distinct > 1 && column.distinct <= RESULT_CHART_MAX_SERIES)
      : undefined;
    if (split) return { type: 'line', x: time.name, ys: ys.slice(0, 1), aggregate: 'sum', splitBy: split.name };
    return { type: 'line', x: time.name, ys, aggregate: aggregateFor(time) };
  }
  if (category && ys.length > 0) return { type: 'bar', x: category.name, ys, aggregate: aggregateFor(category) };
  if (measures.length >= 2) return { type: 'scatter', x: measures[0].name, ys: [measures[1].name], aggregate: 'none' };
  if (measures.length === 1) return { type: 'histogram', x: measures[0].name, ys: [], aggregate: 'count' };
  if (time) return { type: 'line', x: time.name, ys: [], aggregate: 'count' };
  if (category) return { type: 'bar', x: category.name, ys: [], aggregate: 'count' };
  return null;
};

export interface ResultChartSelectionScope {
  rows: ResultChartRow[];
  /** Columns the selection covers, in result order; empty for whole-row selections. */
  columns: string[];
}

/**
 * Narrow the chart to what the user selected. A single row or cell is a click,
 * not a selection worth charting, so it scopes nothing.
 */
export const resolveResultChartSelection = (
  rows: ResultChartRow[],
  columns: string[],
  selectedRowKeys: readonly unknown[] = [],
  selectedCells: ReadonlySet<string> = new Set(),
): ResultChartSelectionScope | null => {
  const rowKeys = new Set<string>();
  const cellColumns = new Set<string>();
  selectedCells.forEach((cellKey) => {
    const parsed = splitCellKey(cellKey);
    if (!parsed) return;
    rowKeys.add(parsed.rowKey);
    cellColumns.add(parsed.colName);
  });
  if (rowKeys.size === 0) selectedRowKeys.forEach((key) => rowKeys.add(String(key)));
  if (rowKeys.size < 2) return null;
  const scopedRows = rows.filter((row) => rowKeys.has(String(row?.[GONAVI_ROW_KEY])));
  if (scopedRows.length < 2) return null;
  return {
    rows: scopedRows,
    columns: cellColumns.size > 0 ? columns.filter((column) => cellColumns.has(column)) : [],
  };
};

const seriesFor = (config: ResultChartConfig): ResultChartSeries[] => (
  config.ys.length === 0
    ? [{ key: RESULT_CHART_COUNT_SERIES, label: '' }]
    : config.ys.slice(0, RESULT_CHART_MAX_SERIES).map((label, index) => ({ key: `s${index}`, label }))
);

const buildHistogram = (rows: ResultChartRow[], column: string): ResultChartData => {
  const values = rows.map((row) => toChartNumber(row?.[column])).filter((value): value is number => value !== null);
  const series = [{ key: RESULT_CHART_COUNT_SERIES, label: '' }];
  const skippedRows = rows.length - values.length;
  if (values.length === 0) return { points: [], series, xKind: 'number', truncated: false, skippedRows };
  const min = values.reduce((lowest, value) => Math.min(lowest, value), Infinity);
  const max = values.reduce((highest, value) => Math.max(highest, value), -Infinity);
  const binCount = min === max ? 1 : Math.min(30, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const width = min === max ? 1 : (max - min) / binCount;
  const counts = new Array<number>(binCount).fill(0);
  values.forEach((value) => {
    counts[Math.min(binCount - 1, Math.floor((value - min) / width))] += 1;
  });
  const round = (value: number) => Number(value.toPrecision(6));
  const points = counts.map((count, index) => ({
    [RESULT_CHART_X_KEY]: min === max
      ? String(round(min))
      : `${round(min + index * width)} – ${round(min + (index + 1) * width)}`,
    [RESULT_CHART_COUNT_SERIES]: count,
  }));
  return { points, series, xKind: 'category', truncated: false, skippedRows };
};

const foldPieSlices = (
  points: Array<Record<string, string | number | null>>,
  seriesKey: string,
): Array<Record<string, string | number | null>> => {
  const positive = points
    .filter((point) => typeof point[seriesKey] === 'number' && (point[seriesKey] as number) > 0)
    .sort((left, right) => (right[seriesKey] as number) - (left[seriesKey] as number));
  if (positive.length <= RESULT_CHART_PIE_SLICES + 1) return positive;
  const rest = positive.slice(RESULT_CHART_PIE_SLICES)
    .reduce((total, point) => total + (point[seriesKey] as number), 0);
  return [...positive.slice(0, RESULT_CHART_PIE_SLICES), { [RESULT_CHART_X_KEY]: RESULT_CHART_OTHER, [seriesKey]: rest }];
};

const groupChartPoints = (
  rows: ResultChartRow[],
  config: ResultChartConfig,
  xKind: ResultChartColumnKind,
  series: ResultChartSeries[],
  aggregate: ResultChartAggregate,
): { points: Array<Record<string, string | number | null>>; skippedRows: number } => {
  const countOnly = config.ys.length === 0;
  const groups = new Map<string, { x: string | number; values: ChartAccumulator[] }>();
  let skippedRows = 0;
  rows.forEach((row) => {
    const x = chartXValue(row?.[config.x], xKind);
    if (x === null) {
      skippedRows += 1;
      return;
    }
    const group = groups.get(String(x)) ?? { x, values: series.map(emptyChartAccumulator) };
    series.forEach((item, index) => {
      const value = countOnly ? 1 : toChartNumber(row?.[item.label]);
      if (value !== null) accumulateChartValue(group.values[index], value);
    });
    groups.set(String(x), group);
  });
  const points = [...groups.values()].map((group) => {
    const point: Record<string, string | number | null> = { [RESULT_CHART_X_KEY]: group.x };
    series.forEach((item, index) => { point[item.key] = finishChartValue(group.values[index], aggregate); });
    return point;
  });
  return { points, skippedRows };
};

/** Turn result rows into chart points for one configuration. */
export const buildResultChartData = (
  rows: ResultChartRow[],
  columns: ResultChartColumn[],
  config: ResultChartConfig,
): ResultChartData => {
  if (config.type === 'histogram') return buildHistogram(rows, config.x);
  if (config.splitBy && RESULT_CHART_SPLIT_TYPES.includes(config.type) && config.ys.length <= 1) {
    return buildSplitResultChartData(rows, columns, { ...config, splitBy: config.splitBy });
  }
  const xKind = columns.find((column) => column.name === config.x)?.kind ?? 'category';
  const series = seriesFor(config);
  const aggregate: ResultChartAggregate = config.ys.length === 0
    ? 'count'
    : (config.type === 'pie' && config.aggregate === 'none' ? 'sum' : config.aggregate);
  let skippedRows = 0;
  let points: Array<Record<string, string | number | null>> = [];
  if (aggregate === 'none') {
    rows.forEach((row) => {
      const x = chartXValue(row?.[config.x], xKind);
      if (x === null) {
        skippedRows += 1;
        return;
      }
      const point: Record<string, string | number | null> = { [RESULT_CHART_X_KEY]: x };
      series.forEach((item) => { point[item.key] = toChartNumber(row?.[item.label]); });
      points.push(point);
    });
  } else {
    ({ points, skippedRows } = groupChartPoints(rows, config, xKind, series, aggregate));
  }

  if (config.type === 'pie') {
    return { points: foldPieSlices(points, series[0].key), series: series.slice(0, 1), xKind, truncated: false, skippedRows };
  }
  if (xKind !== 'category' || config.type === 'scatter') {
    points.sort((left, right) => Number(left[RESULT_CHART_X_KEY]) - Number(right[RESULT_CHART_X_KEY]));
  } else if (config.type === 'bar' && aggregate !== 'none') {
    // Ranked bars read faster than bars in arrival order.
    points.sort((left, right) => Number(right[series[0].key] ?? 0) - Number(left[series[0].key] ?? 0));
  }
  const limit = xKind === 'category' ? MAX_CATEGORY_POINTS : MAX_SERIAL_POINTS;
  const truncated = points.length > limit;
  return { points: truncated ? points.slice(0, limit) : points, series, xKind, truncated, skippedRows };
};

/** Keep a configuration valid when the available columns change. */
export const sanitizeResultChartConfig = (
  config: ResultChartConfig,
  columns: ResultChartColumn[],
): ResultChartConfig | null => {
  const names = new Set(columns.map((column) => column.name));
  if (!names.has(config.x)) return null;
  const ys = config.ys.filter((name) => names.has(name)).slice(0, RESULT_CHART_MAX_SERIES);
  const splitBy = config.splitBy && names.has(config.splitBy) && config.splitBy !== config.x
    ? config.splitBy
    : undefined;
  return { ...config, ys, splitBy };
};
