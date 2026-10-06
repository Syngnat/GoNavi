import type { ReactElement, ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  RESULT_CHART_COUNT_SERIES,
  RESULT_CHART_OTHER,
  RESULT_CHART_X_KEY,
  type ResultChartData,
  type ResultChartSeries,
  type ResultChartType,
} from './resultChartModel';
import { RESULT_CHART_SCATTER_MAX_SERIES, resultChartTheme, type ResultChartTheme } from './resultChartPalette';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface ResultChartCanvasProps {
  type: ResultChartType;
  data: ResultChartData;
  darkMode: boolean;
  translate: Translate;
}

const DOT_LIMIT = 60;
const pad = (value: number) => String(value).padStart(2, '0');
const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const fullNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

const formatValue = (value: unknown): string => (
  typeof value === 'number' ? fullNumber.format(value) : String(value ?? '')
);

const formatTime = (value: number, withClock: boolean): string => {
  const date = new Date(value);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withClock ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
};

/** Everything the per-type renderers share: theme, formatters and common parts. */
interface CanvasContext {
  type: ResultChartType;
  data: ResultChartData;
  theme: ResultChartTheme;
  formatX: (value: unknown) => string;
  seriesName: (series: ResultChartSeries) => string;
  color: (index: number) => string;
  tooltipProps: Record<string, unknown>;
  xAxis: ReactNode;
  yAxis: ReactNode;
  grid: ReactNode;
  legend: ReactNode;
}

const buildContext = ({ type, data, darkMode, translate }: ResultChartCanvasProps): CanvasContext => {
  const theme = resultChartTheme(darkMode);
  const timeHasClock = data.xKind === 'time' && data.points.some((point) => {
    const date = new Date(Number(point[RESULT_CHART_X_KEY]));
    return date.getHours() !== 0 || date.getMinutes() !== 0;
  });
  const formatX = (value: unknown): string => {
    if (data.xKind === 'time') return formatTime(Number(value), timeHasClock);
    if (value === RESULT_CHART_OTHER) return translate('data_grid.chart.other');
    return typeof value === 'number' ? fullNumber.format(value) : String(value ?? '');
  };
  const tick = { fill: theme.mutedText, fontSize: 11 };
  const numericX = data.xKind === 'time' || (data.xKind === 'number' && type !== 'bar' && type !== 'histogram');
  return {
    type,
    data,
    theme,
    formatX,
    seriesName: (series) => {
      if (series.key === RESULT_CHART_COUNT_SERIES) return translate('data_grid.chart.row_count');
      return series.label === RESULT_CHART_OTHER ? translate('data_grid.chart.other') : series.label;
    },
    // A folded "other" series is neutral so it never borrows a palette hue.
    color: (index) => (data.series[index]?.label === RESULT_CHART_OTHER ? theme.neutral : (theme.series[index] ?? theme.neutral)),
    tooltipProps: {
      isAnimationActive: false,
      contentStyle: { background: theme.surface, borderColor: theme.grid, borderRadius: 8, color: theme.text, fontSize: 12 },
      labelStyle: { color: theme.text },
      labelFormatter: (label: unknown) => formatX(label),
      formatter: (value: unknown) => formatValue(value),
    },
    xAxis: (
      <XAxis
        dataKey={RESULT_CHART_X_KEY}
        type={numericX ? 'number' : 'category'}
        scale={data.xKind === 'time' ? 'time' : 'auto'}
        domain={numericX ? ['dataMin', 'dataMax'] : undefined}
        tick={tick}
        stroke={theme.grid}
        tickFormatter={formatX}
        minTickGap={16}
      />
    ),
    yAxis: (
      <YAxis tick={tick} stroke={theme.grid} width={56} tickFormatter={(value: number) => compactNumber.format(value)} />
    ),
    grid: <CartesianGrid stroke={theme.grid} vertical={false} />,
    // A single series is named by the axis title; a legend only adds noise.
    legend: data.series.length > 1
      ? <Legend iconSize={8} wrapperStyle={{ color: theme.text, fontSize: 12 }} />
      : null,
  };
};

const renderPie = (context: CanvasContext): ReactElement => {
  const { data, theme, formatX, color, tooltipProps } = context;
  const [series] = data.series;
  return (
    <PieChart>
      <Pie
        data={data.points}
        dataKey={series.key}
        nameKey={RESULT_CHART_X_KEY}
        innerRadius="45%"
        outerRadius="78%"
        stroke={theme.surface}
        strokeWidth={2}
        isAnimationActive={false}
        label={({ name, percent }: { name?: unknown; percent?: number }) => (
          `${formatX(name)} ${((percent ?? 0) * 100).toFixed(1)}%`
        )}
      >
        {data.points.map((point, index) => (
          <Cell
            key={String(point[RESULT_CHART_X_KEY])}
            fill={point[RESULT_CHART_X_KEY] === RESULT_CHART_OTHER ? theme.neutral : color(index)}
          />
        ))}
      </Pie>
      <Tooltip {...tooltipProps} formatter={(value: unknown, name: unknown) => [formatValue(value), formatX(name)]} />
      <Legend iconSize={8} formatter={(value: unknown) => formatX(value)} wrapperStyle={{ color: theme.text, fontSize: 12 }} />
    </PieChart>
  );
};

const renderScatter = (context: CanvasContext): ReactElement => {
  const { data, theme, color, seriesName, tooltipProps, grid, xAxis, legend } = context;
  const series = data.series.slice(0, RESULT_CHART_SCATTER_MAX_SERIES);
  return (
    <ScatterChart>
      {grid}
      {xAxis}
      <YAxis
        dataKey="y"
        type="number"
        tick={{ fill: theme.mutedText, fontSize: 11 }}
        stroke={theme.grid}
        width={56}
        tickFormatter={(value: number) => compactNumber.format(value)}
      />
      <Tooltip {...tooltipProps} cursor={{ strokeDasharray: '3 3', stroke: theme.mutedText }} />
      {series.length > 1 ? legend : null}
      {series.map((item, index) => (
        <Scatter
          key={item.key}
          name={seriesName(item)}
          data={data.points
            .filter((point) => typeof point[item.key] === 'number')
            .map((point) => ({ [RESULT_CHART_X_KEY]: point[RESULT_CHART_X_KEY], y: point[item.key] }))}
          fill={color(index)}
          stroke={theme.surface}
          strokeWidth={1}
          isAnimationActive={false}
        />
      ))}
    </ScatterChart>
  );
};

const renderTrend = (context: CanvasContext): ReactElement => {
  const { type, data, theme, color, seriesName, tooltipProps, grid, xAxis, yAxis, legend } = context;
  const Chart = type === 'line' ? LineChart : AreaChart;
  // A group missing from an x is "no row there", not a break in the trend;
  // without bridging, sparse split series draw nothing at all.
  const showDots = data.points.length <= DOT_LIMIT;
  const activeDot = { r: 5, stroke: theme.surface, strokeWidth: 2 };
  return (
    <Chart data={data.points}>
      {grid}
      {xAxis}
      {yAxis}
      <Tooltip {...tooltipProps} cursor={{ stroke: theme.mutedText, strokeDasharray: '3 3' }} />
      {legend}
      {data.series.map((item, index) => (type === 'line' ? (
        <Line
          key={item.key}
          type="linear"
          dataKey={item.key}
          name={seriesName(item)}
          stroke={color(index)}
          strokeWidth={2}
          dot={showDots ? { r: 3, strokeWidth: 0, fill: color(index) } : false}
          activeDot={activeDot}
          connectNulls
          isAnimationActive={false}
        />
      ) : (
        <Area
          key={item.key}
          type="linear"
          dataKey={item.key}
          name={seriesName(item)}
          stroke={color(index)}
          strokeWidth={2}
          fill={color(index)}
          fillOpacity={0.14}
          activeDot={activeDot}
          connectNulls
          isAnimationActive={false}
        />
      )))}
    </Chart>
  );
};

const renderBars = (context: CanvasContext): ReactElement => {
  const { type, data, theme, color, seriesName, tooltipProps, grid, xAxis, yAxis, legend } = context;
  const histogram = type === 'histogram';
  return (
    <BarChart data={data.points} barCategoryGap={histogram ? 1 : '18%'} barGap={2}>
      {grid}
      {xAxis}
      {yAxis}
      <Tooltip {...tooltipProps} cursor={{ fill: theme.grid }} />
      {legend}
      {data.series.map((item, index) => (
        <Bar
          key={item.key}
          dataKey={item.key}
          name={seriesName(item)}
          fill={color(index)}
          radius={histogram ? [2, 2, 0, 0] : [4, 4, 0, 0]}
          maxBarSize={56}
          isAnimationActive={false}
        />
      ))}
    </BarChart>
  );
};

/** Recharts rendering of one configuration: one value axis, thin marks, hover tooltips. */
export default function ResultChartCanvas(props: ResultChartCanvasProps) {
  const context = buildContext(props);
  let chart: ReactElement;
  if (props.type === 'pie') chart = renderPie(context);
  else if (props.type === 'scatter') chart = renderScatter(context);
  else if (props.type === 'line' || props.type === 'area') chart = renderTrend(context);
  else chart = renderBars(context);
  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={140}>
      {chart}
    </ResponsiveContainer>
  );
}
