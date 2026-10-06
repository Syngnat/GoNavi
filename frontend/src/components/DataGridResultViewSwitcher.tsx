import React from 'react';
import { Segmented, Tooltip } from 'antd';
import { GnChartIcon, GnJsonIcon, GnTableIcon, GnTextViewIcon } from './icons/gnIcons';
import { t as defaultTranslate, type I18nParams } from '../i18n';
import type { GridViewMode } from './dataGrid/core/dataGridTypes';

export type DataGridResultViewTranslate = (key: string, params?: I18nParams) => string;

export interface DataGridResultViewSwitcherProps {
  viewMode: GridViewMode;
  onViewModeChange: (nextMode: GridViewMode) => void;
  translate?: DataGridResultViewTranslate;
}

const DataGridResultViewSwitcher: React.FC<DataGridResultViewSwitcherProps> = ({
  viewMode,
  onViewModeChange,
  translate = defaultTranslate,
}) => {
  const resultViewLabel = translate('data_grid.view.result_view');
  const viewOptions = [
    { label: translate('data_grid.view.table'), value: 'table', icon: <GnTableIcon /> },
    { label: 'JSON', value: 'json', icon: <GnJsonIcon /> },
    { label: translate('data_grid.view.text'), value: 'text', icon: <GnTextViewIcon /> },
    { label: translate('data_grid.view.chart'), value: 'chart', icon: <GnChartIcon /> },
  ];

  return (
    <div
      data-grid-view-switcher="true"
      className="gn-v2-data-grid-result-switcher"
    >
      <Segmented
        aria-label={resultViewLabel}
        size="small"
        value={viewMode === 'json' || viewMode === 'text' || viewMode === 'chart' ? viewMode : 'table'}
        options={viewOptions.map((option) => ({
          label: <Tooltip title={option.label}>
              <span className="gn-v2-data-grid-result-option">
                {option.icon}
                <span className="gn-v2-data-grid-visually-hidden">{option.label}</span>
              </span>
            </Tooltip>,
          value: option.value,
        }))}
        onChange={(value) => onViewModeChange(String(value) as GridViewMode)}
      />
    </div>
  );
};

export default DataGridResultViewSwitcher;
