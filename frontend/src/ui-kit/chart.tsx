import React, { useMemo } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts';

export type GonaviChartKind = 'line' | 'bar' | 'area' | 'pie' | 'scatter';

export interface GonaviChartSeries {
  key: string;
  name?: string;
  color?: string;
}

export interface GonaviChartProps {
  kind?: GonaviChartKind;
  data: readonly Record<string, unknown>[];
  xKey: string;
  series: readonly GonaviChartSeries[];
  height?: number;
  stacked?: boolean;
  dark?: boolean;
}

export const GONAVI_CHART_COLORS = [
  '#1677ff', '#13c2c2', '#52c41a', '#faad14', '#fa541c', '#722ed1', '#eb2f96', '#a0d911',
] as const;

/** Fills missing series colours from the host palette, cycling when needed. */
export function gonaviChartSeries(series: readonly GonaviChartSeries[]): Required<GonaviChartSeries>[] {
  return series.map((item, index) => ({
    key: item.key,
    name: item.name || item.key,
    color: item.color || GONAVI_CHART_COLORS[index % GONAVI_CHART_COLORS.length],
  }));
}

const axisProps = {
  tick: { fontSize: 11 },
  stroke: 'currentColor',
  strokeOpacity: 0.3,
} as const;

/**
 * Read-only chart for plugin windows. Data comes from the plugin (usually a
 * capability result); the component never fetches or transforms it beyond
 * series colour defaults. Loaded from the separate `@gonavi/plugin-ui/chart`
 * entry so windows without charts do not download recharts.
 */
export const GonaviChart: React.FC<GonaviChartProps> = ({
  kind = 'line',
  data,
  xKey,
  series,
  height = 280,
  stacked = false,
  dark = false,
}) => {
  const resolved = useMemo(() => gonaviChartSeries(series), [series]);
  const chart = (() => {
    if (kind === 'pie') {
      const valueKey = resolved[0]?.key;
      if (!valueKey) return null;
      return (
        <PieChart>
          <Tooltip />
          <Legend />
          <Pie data={data as Record<string, unknown>[]} dataKey={valueKey} nameKey={xKey} outerRadius="75%">
            {data.map((_, index) => (
              <Cell key={index} fill={GONAVI_CHART_COLORS[index % GONAVI_CHART_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      );
    }
    if (kind === 'scatter') {
      const valueKey = resolved[0]?.key;
      if (!valueKey) return null;
      return (
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
          <XAxis dataKey={xKey} {...axisProps} />
          <YAxis {...axisProps} />
          <Tooltip />
          <Legend />
          <Scatter name={resolved[0].name} data={data as Record<string, unknown>[]} dataKey={valueKey} fill={resolved[0].color} />
        </ScatterChart>
      );
    }
    const common = (
      <>
        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
        <XAxis dataKey={xKey} {...axisProps} />
        <YAxis {...axisProps} />
        <Tooltip />
        <Legend />
      </>
    );
    const rows = data as Record<string, unknown>[];
    if (kind === 'bar') {
      return (
        <BarChart data={rows}>
          {common}
          {resolved.map((item) => (
            <Bar key={item.key} dataKey={item.key} name={item.name} fill={item.color} stackId={stacked ? 'stack' : undefined} />
          ))}
        </BarChart>
      );
    }
    if (kind === 'area') {
      return (
        <AreaChart data={rows}>
          {common}
          {resolved.map((item) => (
            <Area key={item.key} dataKey={item.key} name={item.name} stroke={item.color} fill={item.color} fillOpacity={0.18} stackId={stacked ? 'stack' : undefined} />
          ))}
        </AreaChart>
      );
    }
    return (
      <LineChart data={rows}>
        {common}
        {resolved.map((item) => (
          <Line key={item.key} type="monotone" dataKey={item.key} name={item.name} stroke={item.color} dot={false} />
        ))}
      </LineChart>
    );
  })();

  if (!chart) return null;
  return (
    <div className={`gonavi-chart${dark ? ' is-dark' : ''}`} style={{ height, color: dark ? '#c9d1d9' : '#1f2328' }}>
      <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
    </div>
  );
};
