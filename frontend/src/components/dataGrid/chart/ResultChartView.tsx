import { Empty, Typography } from 'antd';
import type { Key } from 'react';
import ResultChartCanvas from './ResultChartCanvas';
import ResultChartToolbar from './ResultChartToolbar';
import type { ResultChartRow } from './resultChartModel';
import { useResultChartState } from './useResultChartState';
import './ResultChartView.css';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface ResultChartViewProps {
  rows: ResultChartRow[];
  columns: string[];
  columnMetaMap?: Record<string, { type?: string }>;
  columnMetaMapByLowerName?: Record<string, { type?: string }>;
  selectedRowKeys?: readonly Key[];
  selectedCells?: ReadonlySet<string>;
  darkMode: boolean;
  translate: Translate;
  onReturnToTable: () => void;
}

/** Result view that charts the loaded rows (or the current selection) in one click. */
export default function ResultChartView({
  rows,
  columns,
  columnMetaMap,
  columnMetaMapByLowerName,
  selectedRowKeys,
  selectedCells,
  darkMode,
  translate,
  onReturnToTable,
}: ResultChartViewProps) {
  const chart = useResultChartState({ rows, columns, columnMetaMap, columnMetaMapByLowerName, selectedRowKeys, selectedCells });
  const { config, data } = chart;

  let body;
  if (rows.length === 0) {
    body = <Empty description={translate('data_grid.chart.empty.no_rows')} />;
  } else if (!config || !data) {
    body = <Empty description={translate('data_grid.chart.empty.no_columns')} />;
  } else if (data.points.length === 0) {
    body = <Empty description={translate('data_grid.chart.empty.no_values')} />;
  } else {
    body = <ResultChartCanvas type={config.type} data={data} darkMode={darkMode} translate={translate} />;
  }

  const notes = [
    translate('data_grid.chart.source', { count: chart.rowCount }),
    data?.truncated ? translate('data_grid.chart.truncated', { count: data.points.length }) : '',
    data && data.skippedRows > 0 ? translate('data_grid.chart.skipped', { count: data.skippedRows }) : '',
  ].filter(Boolean);

  return (
    <div className="gn-result-chart" data-grid-chart-view="true">
      <ResultChartToolbar chart={chart} translate={translate} onReturnToTable={onReturnToTable} />
      <div className="gn-result-chart-body">{body}</div>
      <Typography.Text type="secondary" className="gn-result-chart-notes">{notes.join(' · ')}</Typography.Text>
    </div>
  );
}
