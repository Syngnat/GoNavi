import type { ResultChartAggregate, ResultChartColumnKind } from './resultChartTypes';

const NUMBER_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Numbers as drivers deliver them: decimals and big integers often arrive as strings. */
export const toChartNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !NUMBER_PATTERN.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * ISO-like dates and datetimes. A bare date is a calendar day in the reader's
 * zone: Date.parse would read it as UTC midnight, which shows as 08:00 in
 * UTC+8 and shifts every point.
 */
export const toChartTime = (value: unknown): number | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!DATE_PATTERN.test(text)) return null;
  const normalized = DATE_ONLY_PATTERN.test(text) ? `${text}T00:00:00` : text.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
};

export const isEmptyChartValue = (value: unknown): boolean => value === null || value === undefined || value === '';

export const chartCategoryLabel = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export const chartXValue = (value: unknown, kind: ResultChartColumnKind): string | number | null => {
  if (kind === 'time') return toChartTime(value);
  if (kind === 'number') return toChartNumber(value);
  return isEmptyChartValue(value) ? null : chartCategoryLabel(value);
};

export interface ChartAccumulator {
  sum: number;
  count: number;
  min: number;
  max: number;
}

export const emptyChartAccumulator = (): ChartAccumulator => ({ sum: 0, count: 0, min: Infinity, max: -Infinity });

export const accumulateChartValue = (target: ChartAccumulator, value: number) => {
  target.sum += value;
  target.count += 1;
  target.min = Math.min(target.min, value);
  target.max = Math.max(target.max, value);
};

export const finishChartValue = (target: ChartAccumulator, aggregate: ResultChartAggregate): number | null => {
  if (aggregate === 'count') return target.count;
  if (target.count === 0) return null;
  if (aggregate === 'avg') return target.sum / target.count;
  if (aggregate === 'min') return target.min;
  if (aggregate === 'max') return target.max;
  return target.sum;
};
