import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const marks = vi.hoisted(() => ({ calls: [] as Array<{ type: string; props: any }> }));

vi.mock('recharts', () => {
  const capture = (type: string) => (props: any) => {
    marks.calls.push({ type, props });
    return <>{props.children}</>;
  };
  return {
    Area: capture('Area'),
    AreaChart: capture('AreaChart'),
    Bar: capture('Bar'),
    BarChart: capture('BarChart'),
    CartesianGrid: capture('CartesianGrid'),
    Cell: capture('Cell'),
    Legend: capture('Legend'),
    Line: capture('Line'),
    LineChart: capture('LineChart'),
    Pie: capture('Pie'),
    PieChart: capture('PieChart'),
    ResponsiveContainer: capture('ResponsiveContainer'),
    Scatter: capture('Scatter'),
    ScatterChart: capture('ScatterChart'),
    Tooltip: capture('Tooltip'),
    XAxis: capture('XAxis'),
    YAxis: capture('YAxis'),
  };
});

import ResultChartCanvas from './ResultChartCanvas';
import { RESULT_CHART_OTHER, type ResultChartData } from './resultChartModel';
import { resultChartTheme } from './resultChartPalette';

const t = (key: string) => key;
const render = (type: any, data: ResultChartData, darkMode = false) => {
  marks.calls = [];
  act(() => {
    create(<ResultChartCanvas type={type} data={data} darkMode={darkMode} translate={t} />);
  });
  return (name: string) => marks.calls.filter((call) => call.type === name).map((call) => call.props);
};

const day = (date: number) => new Date(2026, 9, date).getTime();

describe('ResultChartCanvas', () => {
  beforeEach(() => {
    marks.calls = [];
  });

  it('bridges gaps of sparse split series and keeps "other" neutral', () => {
    const marksOf = render('line', {
      xKind: 'time',
      truncated: false,
      skippedRows: 0,
      series: [{ key: 's0', label: 'east' }, { key: 's1', label: RESULT_CHART_OTHER }],
      points: [{ x: day(1), s0: 10, s1: null }, { x: day(2), s0: null, s1: 4 }, { x: day(3), s0: 12, s1: 6 }],
    });
    const lines = marksOf('Line');
    const theme = resultChartTheme(false);
    expect(lines.map((line) => line.connectNulls)).toEqual([true, true]);
    expect(lines.map((line) => line.stroke)).toEqual([theme.series[0], theme.neutral]);
    expect(lines.map((line) => line.name)).toEqual(['east', 'data_grid.chart.other']);
    expect(marksOf('Legend')).toHaveLength(1);
    // Calendar days carry no clock, so ticks show the date alone.
    expect(marksOf('XAxis')[0].tickFormatter(day(1))).toBe('2026-10-01');
  });

  it('draws one unlabelled series without a legend', () => {
    const marksOf = render('bar', {
      xKind: 'category',
      truncated: false,
      skippedRows: 0,
      series: [{ key: '__gonavi_chart_count__', label: '' }],
      points: [{ x: 'ok', __gonavi_chart_count__: 3 }],
    });
    expect(marksOf('Legend')).toHaveLength(0);
    expect(marksOf('Bar')[0]).toMatchObject({ name: 'data_grid.chart.row_count', radius: [4, 4, 0, 0] });
  });

  it('uses the dark steps of the palette in dark mode', () => {
    const marksOf = render('area', {
      xKind: 'number',
      truncated: false,
      skippedRows: 0,
      series: [{ key: 's0', label: 'v' }],
      points: [{ x: 1, s0: 2 }],
    }, true);
    expect(marksOf('Area')[0].stroke).toBe(resultChartTheme(true).series[0]);
  });

  it('colors pie slices in palette order and the remainder neutral', () => {
    const marksOf = render('pie', {
      xKind: 'category',
      truncated: false,
      skippedRows: 0,
      series: [{ key: 's0', label: 'value' }],
      points: [{ x: 'a', s0: 5 }, { x: RESULT_CHART_OTHER, s0: 2 }],
    });
    const theme = resultChartTheme(false);
    expect(marksOf('Cell').map((cell) => cell.fill)).toEqual([theme.series[0], theme.neutral]);
  });
});
