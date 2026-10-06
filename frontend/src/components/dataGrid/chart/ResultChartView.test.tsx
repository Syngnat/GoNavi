import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const view = vi.hoisted(() => ({
  canvas: null as any,
  segmented: null as any,
  selects: {} as Record<string, any>,
  switches: [] as any[],
}));

vi.mock('./ResultChartCanvas', () => ({
  default: (props: any) => {
    view.canvas = props;
    return <div data-chart-canvas="true" />;
  },
}));

vi.mock('antd', () => ({
  Button: ({ children, onClick }: any) => <button type="button" onClick={onClick}>{children}</button>,
  Empty: ({ description }: any) => <div data-empty="true">{description}</div>,
  Segmented: (props: any) => {
    view.segmented = props;
    return null;
  },
  Select: (props: any) => {
    view.selects[props.className] = props;
    return null;
  },
  Switch: (props: any) => {
    view.switches.push(props);
    return null;
  },
  Typography: { Text: ({ children }: any) => <span>{children}</span> },
}));

import ResultChartView, { type ResultChartViewProps } from './ResultChartView';

const ROW_KEY = '__gonavi_row_key__';
const rows = [
  { [ROW_KEY]: 'r1', day: '2026-10-01', region: 'east', amount: '10' },
  { [ROW_KEY]: 'r2', day: '2026-10-02', region: 'west', amount: '30' },
  { [ROW_KEY]: 'r3', day: '2026-10-03', region: 'east', amount: '20' },
];
const columns = ['day', 'region', 'amount'];
const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}(${Object.values(params).join(',')})` : key);

let renderer: ReactTestRenderer;
const render = (props: Partial<ResultChartViewProps> = {}) => {
  view.selects = {};
  view.switches = [];
  const element = (
    <ResultChartView rows={rows} columns={columns} darkMode={false} translate={t} onReturnToTable={vi.fn()} {...props} />
  );
  act(() => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};

const X_SELECT = 'gn-result-chart-select';
const AGGREGATE_SELECT = 'gn-result-chart-select is-narrow';

describe('ResultChartView', () => {
  beforeEach(() => {
    renderer = undefined as unknown as ReactTestRenderer;
  });

  it('charts the result in one click with a suggested configuration', () => {
    render();
    expect(view.canvas.type).toBe('line');
    expect(view.canvas.data.points.map((point: any) => point.s0)).toEqual([10, 30, 20]);
    expect(view.segmented.value).toBe('line');
    expect(renderer.root.findAll((node) => node.type === 'span'
      && String(node.children[0]).startsWith('data_grid.chart.source(3)'))).toHaveLength(1);
  });

  it('lets the reader switch chart type and grouping', () => {
    render();
    act(() => view.segmented.onChange('bar'));
    act(() => view.selects[X_SELECT].onChange('region'));
    act(() => view.selects[AGGREGATE_SELECT].onChange('sum'));
    expect(view.canvas.type).toBe('bar');
    expect(view.canvas.data.points).toEqual([{ x: 'east', s0: 30 }, { x: 'west', s0: 30 }]);
  });

  it('switches to a distribution of the measure', () => {
    render();
    act(() => view.segmented.onChange('histogram'));
    expect(view.canvas.type).toBe('histogram');
    expect(view.canvas.data.points.length).toBeGreaterThan(0);
    // A distribution has one measure and nothing to aggregate.
    expect(view.selects[X_SELECT].value).toBe('amount');
    expect(renderer.root.findAll((node) => node.type === 'span'
      && node.children[0] === 'data_grid.chart.aggregate')).toHaveLength(0);
  });

  it('charts only the selected cells until the reader turns it off', () => {
    const cells = new Set([`r1\u0001region`, `r1\u0001amount`, `r2\u0001region`, `r2\u0001amount`]);
    render({ selectedCells: cells });
    expect(view.canvas.type).toBe('bar');
    expect(view.canvas.data.points).toEqual([{ x: 'east', s0: 10 }, { x: 'west', s0: 30 }]);
    const [selectionSwitch] = view.switches;
    expect(selectionSwitch.checked).toBe(true);

    act(() => selectionSwitch.onChange(false));
    expect(view.canvas.data.points).toHaveLength(3);
  });

  it('splits a measure into one series per group and lets the reader merge them', () => {
    const daily = [
      { [ROW_KEY]: 'a', day: '2026-10-01', region: 'east', amount: '10' },
      { [ROW_KEY]: 'b', day: '2026-10-01', region: 'west', amount: '5' },
      { [ROW_KEY]: 'c', day: '2026-10-02', region: 'east', amount: '7' },
    ];
    render({ rows: daily });
    expect(view.canvas.data.series.map((series: any) => series.label)).toEqual(['east', 'west']);
    act(() => view.selects['gn-result-chart-select is-split'].onChange(undefined));
    expect(view.canvas.data.series.map((series: any) => series.label)).toEqual(['amount']);
    expect(view.canvas.data.points.map((point: any) => point.s0)).toEqual([15, 7]);
  });

  it('explains why nothing is drawn', () => {
    render({ rows: [] });
    expect(renderer.root.findByProps({ 'data-empty': 'true' }).children).toEqual(['data_grid.chart.empty.no_rows']);
    renderer = undefined as unknown as ReactTestRenderer;
    render({ rows: [{ [ROW_KEY]: 'r1', note: null }], columns: ['note'] });
    expect(renderer.root.findByProps({ 'data-empty': 'true' }).children).toEqual(['data_grid.chart.empty.no_values']);
    renderer = undefined as unknown as ReactTestRenderer;
    render({ rows: [{ [ROW_KEY]: 'r1' }], columns: [] });
    expect(renderer.root.findByProps({ 'data-empty': 'true' }).children).toEqual(['data_grid.chart.empty.no_columns']);
  });
});
