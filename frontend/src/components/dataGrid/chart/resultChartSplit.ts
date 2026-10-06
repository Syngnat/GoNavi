import {
  RESULT_CHART_MAX_SERIES,
  RESULT_CHART_OTHER,
  RESULT_CHART_X_KEY,
  type ResultChartAggregate,
  type ResultChartColumn,
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
  toChartNumber,
  type ChartAccumulator,
} from './resultChartValues';

const MAX_SPLIT_POINTS = 2_000;

/**
 * Keep the largest split values as their own series and fold the rest into
 * "other": eight palette slots are never cycled into look-alike colors.
 */
const rankSplitSeries = (
  rows: ResultChartRow[],
  splitBy: string,
  measure: string | undefined,
): { series: ResultChartSeries[]; keyOf: (label: string) => string } => {
  const totals = new Map<string, number>();
  rows.forEach((row) => {
    const value = measure ? toChartNumber(row?.[measure]) : 1;
    if (value === null) return;
    const label = chartCategoryLabel(row?.[splitBy]);
    totals.set(label, (totals.get(label) ?? 0) + Math.abs(value));
  });
  const ranked = [...totals.keys()].sort((left, right) => (totals.get(right) ?? 0) - (totals.get(left) ?? 0));
  const kept = ranked.length > RESULT_CHART_MAX_SERIES ? ranked.slice(0, RESULT_CHART_MAX_SERIES - 1) : ranked;
  const series = kept.map((label, index) => ({ key: `s${index}`, label }));
  const otherKey = `s${kept.length}`;
  if (ranked.length > kept.length) series.push({ key: otherKey, label: RESULT_CHART_OTHER });
  const keys = new Map(kept.map((label, index) => [label, `s${index}`]));
  return { series, keyOf: (label) => keys.get(label) ?? otherKey };
};

/** One series per value of `splitBy` (e.g. a line per region) for one measure or a row count. */
export const buildSplitResultChartData = (
  rows: ResultChartRow[],
  columns: ResultChartColumn[],
  config: ResultChartConfig & { splitBy: string },
): ResultChartData => {
  const xKind = columns.find((column) => column.name === config.x)?.kind ?? 'category';
  const measure = config.ys[0];
  // Several rows can share an (x, group) cell, so "no aggregation" means summing them.
  const aggregate: ResultChartAggregate = !measure ? 'count' : (config.aggregate === 'none' ? 'sum' : config.aggregate);
  const { series, keyOf } = rankSplitSeries(rows, config.splitBy, measure);
  const groups = new Map<string, { x: string | number; values: Map<string, ChartAccumulator> }>();
  let skippedRows = 0;
  rows.forEach((row) => {
    const x = chartXValue(row?.[config.x], xKind);
    if (x === null) {
      skippedRows += 1;
      return;
    }
    const value = measure ? toChartNumber(row?.[measure]) : 1;
    if (value === null) return;
    const group = groups.get(String(x)) ?? { x, values: new Map<string, ChartAccumulator>() };
    const seriesKey = keyOf(chartCategoryLabel(row?.[config.splitBy]));
    const accumulator = group.values.get(seriesKey) ?? emptyChartAccumulator();
    accumulateChartValue(accumulator, value);
    group.values.set(seriesKey, accumulator);
    groups.set(String(x), group);
  });
  let points = [...groups.values()].map((group) => {
    const point: Record<string, string | number | null> = { [RESULT_CHART_X_KEY]: group.x };
    series.forEach((item) => {
      const accumulator = group.values.get(item.key);
      point[item.key] = accumulator ? finishChartValue(accumulator, aggregate) : null;
    });
    return point;
  });
  if (xKind !== 'category') {
    points.sort((left, right) => Number(left[RESULT_CHART_X_KEY]) - Number(right[RESULT_CHART_X_KEY]));
  }
  const truncated = points.length > MAX_SPLIT_POINTS;
  if (truncated) points = points.slice(0, MAX_SPLIT_POINTS);
  return { points, series, xKind, truncated, skippedRows };
};
