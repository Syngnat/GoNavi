export type ResultChartType = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'histogram';
export type ResultChartAggregate = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max';
export type ResultChartColumnKind = 'number' | 'time' | 'category';

export const RESULT_CHART_TYPES: readonly ResultChartType[] = ['bar', 'line', 'area', 'pie', 'scatter', 'histogram'];
export const RESULT_CHART_AGGREGATES: readonly ResultChartAggregate[] = ['none', 'sum', 'avg', 'count', 'min', 'max'];
/** Chart types that can draw one series per value of a grouping column. */
export const RESULT_CHART_SPLIT_TYPES: readonly ResultChartType[] = ['bar', 'line', 'area'];

/** At most eight series: the categorical palette has eight fixed slots and is never cycled. */
export const RESULT_CHART_MAX_SERIES = 8;
/** Pie slices before the remainder folds into "other" (seven hues + a neutral). */
export const RESULT_CHART_PIE_SLICES = 7;

export const RESULT_CHART_X_KEY = 'x';
export const RESULT_CHART_OTHER = '__gonavi_chart_other__';
/** Series key for "number of rows" when nothing is measured. */
export const RESULT_CHART_COUNT_SERIES = '__gonavi_chart_count__';

export interface ResultChartColumn {
  name: string;
  kind: ResultChartColumnKind;
  /** Distinct non-empty values in the inference sample. */
  distinct: number;
  /** Non-empty values in the inference sample. */
  filled: number;
  /** Largest absolute value in the sample, for numbers; 0 otherwise. */
  magnitude: number;
  /** Looks like a key (id, *_id): never suggested as a measure. */
  identifier: boolean;
}

export interface ResultChartConfig {
  type: ResultChartType;
  x: string;
  ys: string[];
  aggregate: ResultChartAggregate;
  /** One series per value of this column (bar, line and area with one measure). */
  splitBy?: string;
}

export interface ResultChartSeries {
  /** Safe dataKey: column names may contain dots, which recharts reads as paths. */
  key: string;
  label: string;
}

export interface ResultChartData {
  points: Array<Record<string, string | number | null>>;
  series: ResultChartSeries[];
  xKind: ResultChartColumnKind;
  /** Points were cut to keep the chart readable. */
  truncated: boolean;
  /** Rows that had no usable x (or, for a distribution, no number). */
  skippedRows: number;
}

export type ResultChartRow = Record<string, unknown>;
