import { describe, expect, it } from 'vitest';
import {
  RESULT_CHART_COUNT_SERIES,
  RESULT_CHART_OTHER,
  buildResultChartData,
  inferResultChartColumns,
  resolveResultChartSelection,
  sanitizeResultChartConfig,
  suggestResultChartConfig,
  toChartNumber,
  toChartTime,
} from './resultChartModel';

const ROW_KEY = '__gonavi_row_key__';
const CELL = '\u0001';

const orders = [
  { [ROW_KEY]: 'r1', id: 1, day: '2026-10-01', region: 'east', amount: '120.50', qty: 3 },
  { [ROW_KEY]: 'r2', id: 2, day: '2026-10-01', region: 'west', amount: '80', qty: 1 },
  { [ROW_KEY]: 'r3', id: 3, day: '2026-10-02', region: 'east', amount: '200', qty: 5 },
  { [ROW_KEY]: 'r4', id: 4, day: '2026-10-03', region: 'north', amount: null, qty: 2 },
];
const columns = ['id', 'day', 'region', 'amount', 'qty'];

describe('value parsing', () => {
  it('reads numbers that drivers deliver as strings, but not codes with letters', () => {
    expect(toChartNumber('120.50')).toBe(120.5);
    expect(toChartNumber('9007199254740993')).toBe(9007199254740992);
    expect(toChartNumber(' -3e2 ')).toBe(-300);
    expect(toChartNumber('A-100')).toBeNull();
    expect(toChartNumber('')).toBeNull();
    expect(toChartNumber(true)).toBeNull();
  });

  it('reads ISO-like dates and datetimes', () => {
    // A bare date is local midnight, not UTC midnight shown as 08:00 in UTC+8.
    expect(toChartTime('2026-10-01')).toBe(new Date(2026, 9, 1).getTime());
    expect(toChartTime('2026-10-01 08:30:00')).toBe(Date.parse('2026-10-01T08:30:00'));
    expect(toChartTime('2026-10-01T08:30:00.123+08:00')).toBe(Date.parse('2026-10-01T08:30:00.123+08:00'));
    expect(toChartTime('10/01/2026')).toBeNull();
  });
});

describe('inferResultChartColumns', () => {
  it('classifies columns by their values and declared types', () => {
    const inferred = inferResultChartColumns(orders, columns, (name) => (name === 'qty' ? { type: 'int' } : undefined));
    expect(inferred.map((column) => [column.name, column.kind, column.identifier])).toEqual([
      ['id', 'number', true],
      ['day', 'time', false],
      ['region', 'category', false],
      ['amount', 'number', false],
      ['qty', 'number', false],
    ]);
    expect(inferred.find((column) => column.name === 'day')).toMatchObject({ distinct: 3, filled: 4 });
  });

  it('trusts a declared temporal type when values are not ISO strings', () => {
    const [column] = inferResultChartColumns([{ created: 'Oct 1' }], ['created'], () => ({ type: 'timestamp' }));
    expect(column.kind).toBe('time');
  });
});

describe('suggestResultChartConfig', () => {
  it('plots a measure over time with one line per group', () => {
    const config = suggestResultChartConfig(inferResultChartColumns(orders, columns));
    expect(config).toEqual({ type: 'line', x: 'day', ys: ['amount'], aggregate: 'sum', splitBy: 'region' });
  });

  it('keeps only measures of a similar scale on one axis', () => {
    const rows = [
      { day: '2026-10-01', revenue: 12000, cost: 4000, orders: 12 },
      { day: '2026-10-02', revenue: 15000, cost: 5200, orders: 15 },
    ];
    expect(suggestResultChartConfig(inferResultChartColumns(rows, ['day', 'revenue', 'cost', 'orders'])))
      .toEqual({ type: 'line', x: 'day', ys: ['revenue', 'cost'], aggregate: 'none' });
  });

  it('compares measures across categories when there is no time column', () => {
    const rows = [{ region: 'east', total: 3 }, { region: 'west', total: 5 }];
    expect(suggestResultChartConfig(inferResultChartColumns(rows, ['region', 'total'])))
      .toEqual({ type: 'bar', x: 'region', ys: ['total'], aggregate: 'none' });
  });

  it('shows the distribution of a lone measure and counts rows of a lone category', () => {
    const numbers = [{ latency: 12 }, { latency: 40 }];
    expect(suggestResultChartConfig(inferResultChartColumns(numbers, ['latency'])))
      .toMatchObject({ type: 'histogram', x: 'latency' });
    const labels = [{ status: 'ok' }, { status: 'ok' }, { status: 'failed' }];
    expect(suggestResultChartConfig(inferResultChartColumns(labels, ['status'])))
      .toEqual({ type: 'bar', x: 'status', ys: [], aggregate: 'count' });
  });

  it('does not suggest keys as measures', () => {
    const rows = [{ id: 1, user_id: 7 }, { id: 2, user_id: 8 }];
    expect(suggestResultChartConfig(inferResultChartColumns(rows, ['id', 'user_id'])))
      .toEqual({ type: 'bar', x: 'id', ys: [], aggregate: 'count' });
  });
});

describe('resolveResultChartSelection', () => {
  it('scopes to the rows and columns of a cell selection', () => {
    const cells = new Set([`r1${CELL}day`, `r1${CELL}amount`, `r3${CELL}day`, `r3${CELL}amount`]);
    const scope = resolveResultChartSelection(orders, columns, [], cells);
    expect(scope?.rows.map((row) => row[ROW_KEY])).toEqual(['r1', 'r3']);
    expect(scope?.columns).toEqual(['day', 'amount']);
  });

  it('scopes to whole selected rows', () => {
    const scope = resolveResultChartSelection(orders, columns, ['r2', 'r4']);
    expect(scope?.rows).toHaveLength(2);
    expect(scope?.columns).toEqual([]);
  });

  it('ignores a single clicked cell', () => {
    expect(resolveResultChartSelection(orders, columns, [], new Set([`r1${CELL}amount`]))).toBeNull();
  });
});

describe('buildResultChartData', () => {
  const inferred = inferResultChartColumns(orders, columns);

  it('aggregates per x, keeps time ascending and uses safe series keys', () => {
    const data = buildResultChartData(orders, inferred, { type: 'line', x: 'day', ys: ['amount'], aggregate: 'sum' });
    expect(data.series).toEqual([{ key: 's0', label: 'amount' }]);
    expect(data.xKind).toBe('time');
    expect(data.points).toEqual([
      { x: new Date(2026, 9, 1).getTime(), s0: 200.5 },
      { x: new Date(2026, 9, 2).getTime(), s0: 200 },
      // A group without any value is a gap, not a zero.
      { x: new Date(2026, 9, 3).getTime(), s0: null },
    ]);
  });

  it('draws one series per group value and folds the tail into other', () => {
    const data = buildResultChartData(orders, inferred, {
      type: 'line', x: 'day', ys: ['amount'], aggregate: 'sum', splitBy: 'region',
    });
    expect(data.series.map((series) => series.label)).toEqual(['east', 'west']);
    expect(data.points[0]).toEqual({ x: new Date(2026, 9, 1).getTime(), s0: 120.5, s1: 80 });
    expect(data.points[1]).toEqual({ x: new Date(2026, 9, 2).getTime(), s0: 200, s1: null });

    const many = Array.from({ length: 12 }, (_, index) => ({ day: '2026-10-01', shop: `s${index}`, sales: 100 - index }));
    const folded = buildResultChartData(many, inferResultChartColumns(many, ['day', 'shop', 'sales']), {
      type: 'bar', x: 'day', ys: ['sales'], aggregate: 'sum', splitBy: 'shop',
    });
    expect(folded.series).toHaveLength(8);
    expect(folded.series[7].label).toBe(RESULT_CHART_OTHER);
    expect(folded.points[0].s7).toBe(93 + 92 + 91 + 90 + 89);
  });

  it('ranks aggregated bars and averages ignoring empty values', () => {
    const data = buildResultChartData(orders, inferred, { type: 'bar', x: 'region', ys: ['qty'], aggregate: 'avg' });
    expect(data.points).toEqual([
      { x: 'east', s0: 4 },
      { x: 'north', s0: 2 },
      { x: 'west', s0: 1 },
    ]);
  });

  it('counts rows when no measure is chosen', () => {
    const data = buildResultChartData(orders, inferred, { type: 'bar', x: 'region', ys: [], aggregate: 'none' });
    expect(data.series[0].key).toBe(RESULT_CHART_COUNT_SERIES);
    expect(data.points[0]).toEqual({ x: 'east', [RESULT_CHART_COUNT_SERIES]: 2 });
  });

  it('folds pie slices past the palette into one remainder slice', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ name: `n${index}`, value: 10 - index }));
    const data = buildResultChartData(rows, inferResultChartColumns(rows, ['name', 'value']), {
      type: 'pie', x: 'name', ys: ['value'], aggregate: 'none',
    });
    expect(data.points).toHaveLength(8);
    expect(data.points[7]).toEqual({ x: RESULT_CHART_OTHER, s0: 3 + 2 + 1 });
  });

  it('bins a distribution and reports rows without a number', () => {
    const rows = [...Array.from({ length: 25 }, (_, index) => ({ v: index })), { v: null }];
    const data = buildResultChartData(rows, inferResultChartColumns(rows, ['v']), {
      type: 'histogram', x: 'v', ys: [], aggregate: 'count',
    });
    expect(data.points).toHaveLength(5);
    expect(data.points.reduce((total, point) => total + Number(point[RESULT_CHART_COUNT_SERIES]), 0)).toBe(25);
    expect(data.skippedRows).toBe(1);
  });

  it('skips rows whose x cannot be read', () => {
    const data = buildResultChartData(
      [...orders, { [ROW_KEY]: 'r5', day: null, amount: 1 }],
      inferred,
      { type: 'line', x: 'day', ys: ['amount'], aggregate: 'none' },
    );
    expect(data.skippedRows).toBe(1);
    expect(data.points).toHaveLength(4);
  });
});

describe('sanitizeResultChartConfig', () => {
  it('drops columns that are no longer in the result', () => {
    const inferred = inferResultChartColumns(orders, ['day', 'amount']);
    expect(sanitizeResultChartConfig({ type: 'line', x: 'day', ys: ['amount', 'qty'], aggregate: 'none' }, inferred))
      .toEqual({ type: 'line', x: 'day', ys: ['amount'], aggregate: 'none' });
    expect(sanitizeResultChartConfig({ type: 'bar', x: 'region', ys: [], aggregate: 'count' }, inferred)).toBeNull();
    expect(sanitizeResultChartConfig({ type: 'line', x: 'day', ys: ['amount'], aggregate: 'sum', splitBy: 'region' }, inferred))
      .toEqual({ type: 'line', x: 'day', ys: ['amount'], aggregate: 'sum', splitBy: undefined });
  });
});
