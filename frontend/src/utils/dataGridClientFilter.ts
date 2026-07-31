import type { FilterCondition } from './sql';
import { parseListValues } from './sql';

export type DataGridColumnValueCount = {
  key: string;
  display: string;
  kind: 'nullish' | 'empty' | 'value';
  count: number;
};

const stableSerializeComplexValue = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return 'Infinity';
    if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);

  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerializeComplexValue(item, seen)).join(',')}]`;
    }
    if (value instanceof Date) {
      return JSON.stringify(Number.isNaN(value.getTime()) ? String(value) : value.toISOString());
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerializeComplexValue((value as Record<string, unknown>)[key], seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
};

const normalizeColumnValueCount = (value: unknown): Omit<DataGridColumnValueCount, 'count'> => {
  if (value === null || value === undefined) {
    return { key: 'nullish', display: '', kind: 'nullish' };
  }
  if (value === '') {
    return { key: 'empty', display: '', kind: 'empty' };
  }

  const valueType = typeof value;
  const display = valueType === 'object'
    ? stableSerializeComplexValue(value)
    : String(value);
  return {
    key: `${valueType}:${display}`,
    display,
    kind: 'value',
  };
};

export const countGridColumnValues = <T extends Record<string, any>>(
  rows: T[],
  columnName: string,
): DataGridColumnValueCount[] => {
  const counts = new Map<string, DataGridColumnValueCount>();
  rows.forEach((row) => {
    const normalized = normalizeColumnValueCount(row?.[columnName]);
    const existing = counts.get(normalized.key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(normalized.key, { ...normalized, count: 1 });
    }
  });

  return Array.from(counts.values()).sort((left, right) => (
    right.count - left.count
    || left.display.localeCompare(right.display, undefined, { numeric: true, sensitivity: 'base' })
    || left.key.localeCompare(right.key)
  ));
};

const normalizeCellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return stableSerializeComplexValue(value);
};

const isNullishCell = (value: unknown): boolean => value === null || value === undefined;

const isEmptyCell = (value: unknown): boolean => {
  if (isNullishCell(value)) return true;
  if (typeof value === 'string') return value.length === 0;
  return false;
};

const compareScalar = (cellText: string, expected: string): number => {
  const leftNum = Number(cellText);
  const rightNum = Number(expected);
  if (cellText !== '' && expected !== '' && Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
    if (leftNum === rightNum) return 0;
    return leftNum > rightNum ? 1 : -1;
  }
  return cellText.localeCompare(expected, undefined, { numeric: true, sensitivity: 'base' });
};

const matchSingleCondition = (row: Record<string, any>, condition: FilterCondition): boolean => {
  if (condition?.enabled === false) return true;

  const op = String(condition?.op || '').trim();
  const column = String(condition?.column || '').trim();
  const value = String(condition?.value ?? '');
  const value2 = String(condition?.value2 ?? '');

  // CUSTOM 表达式在结果页仅做客户端过滤时无法安全求值，跳过（视为通过）
  if (op === 'CUSTOM') return true;
  if (!column) return true;

  const cell = row?.[column];
  const cellText = normalizeCellText(cell);

  switch (op) {
    case 'IS_NULL':
      return isNullishCell(cell);
    case 'IS_NOT_NULL':
      return !isNullishCell(cell);
    case 'IS_EMPTY':
      return isEmptyCell(cell);
    case 'IS_NOT_EMPTY':
      return !isEmptyCell(cell);
    case 'BETWEEN': {
      const v1 = value.trim();
      const v2 = value2.trim();
      if (!v1 || !v2) return true;
      return compareScalar(cellText, v1) >= 0 && compareScalar(cellText, v2) <= 0;
    }
    case 'NOT_BETWEEN': {
      const v1 = value.trim();
      const v2 = value2.trim();
      if (!v1 || !v2) return true;
      return !(compareScalar(cellText, v1) >= 0 && compareScalar(cellText, v2) <= 0);
    }
    case 'IN': {
      const items = parseListValues(value);
      if (items.length === 0) return true;
      return items.some((item) => cellText === item);
    }
    case 'NOT_IN': {
      const items = parseListValues(value);
      if (items.length === 0) return true;
      return items.every((item) => cellText !== item);
    }
    case 'CONTAINS':
    case 'LIKE': {
      const v = value.trim();
      if (!v) return true;
      return cellText.toLowerCase().includes(v.toLowerCase());
    }
    case 'NOT_CONTAINS': {
      const v = value.trim();
      if (!v) return true;
      return !cellText.toLowerCase().includes(v.toLowerCase());
    }
    case 'STARTS_WITH': {
      const v = value.trim();
      if (!v) return true;
      return cellText.toLowerCase().startsWith(v.toLowerCase());
    }
    case 'NOT_STARTS_WITH': {
      const v = value.trim();
      if (!v) return true;
      return !cellText.toLowerCase().startsWith(v.toLowerCase());
    }
    case 'ENDS_WITH': {
      const v = value.trim();
      if (!v) return true;
      return cellText.toLowerCase().endsWith(v.toLowerCase());
    }
    case 'NOT_ENDS_WITH': {
      const v = value.trim();
      if (!v) return true;
      return !cellText.toLowerCase().endsWith(v.toLowerCase());
    }
    case '=': {
      const v = value.trim();
      if (!v) return true;
      return compareScalar(cellText, v) === 0;
    }
    case '!=': {
      const v = value.trim();
      if (!v) return true;
      return compareScalar(cellText, v) !== 0;
    }
    case '<': {
      const v = value.trim();
      if (!v) return true;
      return compareScalar(cellText, v) < 0;
    }
    case '<=': {
      const v = value.trim();
      if (!v) return true;
      return compareScalar(cellText, v) <= 0;
    }
    case '>': {
      const v = value.trim();
      if (!v) return true;
      return compareScalar(cellText, v) > 0;
    }
    case '>=': {
      const v = value.trim();
      if (!v) return true;
      return compareScalar(cellText, v) >= 0;
    }
    default: {
      const v = value.trim();
      if (!v) return true;
      return compareScalar(cellText, v) === 0;
    }
  }
};

/**
 * 客户端过滤（查询结果页列头筛选等）：按 AND/OR 逻辑匹配 FilterCondition 列表。
 * 逻辑语义与 buildWhereSQL 一致：第一个条件后，每个条件携带相对前序组合的 AND/OR。
 */
export const filterRowsByGridConditions = <T extends Record<string, any>>(
  rows: T[],
  conditions: FilterCondition[] | undefined,
): T[] => {
  const active = (conditions || []).filter((cond) => cond && cond.enabled !== false);
  if (active.length === 0) return rows;

  return rows.filter((row) => {
    let result = matchSingleCondition(row, active[0]);
    for (let i = 1; i < active.length; i += 1) {
      const logic = String(active[i]?.logic || 'AND').trim().toUpperCase() === 'OR' ? 'OR' : 'AND';
      const matched = matchSingleCondition(row, active[i]);
      result = logic === 'OR' ? (result || matched) : (result && matched);
    }
    return result;
  });
};
