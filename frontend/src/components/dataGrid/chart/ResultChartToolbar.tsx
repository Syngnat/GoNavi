import { Button, Segmented, Select, Switch, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  RESULT_CHART_AGGREGATES,
  RESULT_CHART_SPLIT_TYPES,
  RESULT_CHART_TYPES,
  type ResultChartAggregate,
  type ResultChartType,
} from './resultChartModel';
import type { ResultChartState } from './useResultChartState';

type Translate = (key: string, params?: Record<string, string | number>) => string;

function ChartField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="gn-result-chart-field">
      <Typography.Text type="secondary">{label}</Typography.Text>
      {children}
    </label>
  );
}

/** Chart type, axes, split, aggregation and the selection scope of the chart view. */
export default function ResultChartToolbar({
  chart,
  translate,
  onReturnToTable,
}: {
  chart: ResultChartState;
  translate: Translate;
  onReturnToTable: () => void;
}) {
  const { config } = chart;
  const histogram = config?.type === 'histogram';
  const countOnly = !config || config.ys.length === 0;
  const kindLabel = (kind: string) => translate(`data_grid.chart.column_kind.${kind}`);
  const columnsOf = (kind: string) => chart.columns
    .filter((column) => column.kind === kind && column.name !== config?.x)
    .map((column) => ({ value: column.name, label: column.name }));

  return (
    <div className="gn-result-chart-toolbar">
      <Segmented<ResultChartType>
        size="small"
        aria-label={translate('data_grid.view.chart')}
        value={config?.type}
        disabled={!config}
        onChange={chart.setType}
        options={RESULT_CHART_TYPES.map((type) => ({ value: type, label: translate(`data_grid.chart.type.${type}`) }))}
      />
      <ChartField label={translate(histogram ? 'data_grid.chart.measure' : 'data_grid.chart.x_axis')}>
        <Select
          size="small"
          className="gn-result-chart-select"
          value={config?.x}
          disabled={!config}
          onChange={chart.setX}
          popupMatchSelectWidth={false}
          options={chart.columns
            .filter((column) => !histogram || column.kind === 'number')
            .map((column) => ({ value: column.name, label: `${column.name} · ${kindLabel(column.kind)}` }))}
        />
      </ChartField>
      {histogram ? null : (
        <ChartField label={translate('data_grid.chart.y_axis')}>
          <Select
            size="small"
            mode="multiple"
            className="gn-result-chart-select is-wide"
            value={config?.ys ?? []}
            disabled={!config}
            maxTagCount="responsive"
            placeholder={translate('data_grid.chart.row_count')}
            onChange={chart.setYs}
            options={columnsOf('number')}
          />
        </ChartField>
      )}
      {config && RESULT_CHART_SPLIT_TYPES.includes(config.type) ? (
        <ChartField label={translate('data_grid.chart.split_by')}>
          <Select
            size="small"
            allowClear
            className="gn-result-chart-select is-split"
            value={config.splitBy}
            placeholder={translate('data_grid.chart.split_none')}
            onChange={(value?: string) => chart.setSplitBy(value || undefined)}
            options={columnsOf('category')}
          />
        </ChartField>
      ) : null}
      {histogram ? null : (
        <ChartField label={translate('data_grid.chart.aggregate')}>
          <Select<ResultChartAggregate>
            size="small"
            className="gn-result-chart-select is-narrow"
            value={countOnly ? 'count' : config?.aggregate}
            disabled={countOnly}
            onChange={chart.setAggregate}
            options={RESULT_CHART_AGGREGATES
              .filter((aggregate) => config?.type !== 'pie' || aggregate !== 'none')
              .map((aggregate) => ({ value: aggregate, label: translate(`data_grid.chart.aggregate.${aggregate}`) }))}
          />
        </ChartField>
      )}
      {chart.selection ? (
        <label className="gn-result-chart-field">
          <Switch size="small" checked={chart.selectionOnly} onChange={chart.setSelectionOnly} />
          <Typography.Text>{translate('data_grid.chart.selection_only', { count: chart.selection.rows.length })}</Typography.Text>
        </label>
      ) : null}
      <Button size="small" className="gn-result-chart-back" onClick={onReturnToTable}>
        {translate('data_grid.record_view.back_to_table')}
      </Button>
    </div>
  );
}
