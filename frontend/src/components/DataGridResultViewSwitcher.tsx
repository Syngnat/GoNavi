import React from 'react';
import { Segmented, Tooltip } from 'antd';
import { CodeOutlined, FileTextOutlined, TableOutlined } from '@ant-design/icons';
import { t as defaultTranslate, type I18nParams } from '../i18n';

type GridViewMode = 'table' | 'json' | 'text' | 'fields' | 'ddl' | 'er' | 'sqlLog';

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
    { label: translate('data_grid.view.table'), value: 'table', icon: <TableOutlined /> },
    { label: 'JSON', value: 'json', icon: <CodeOutlined /> },
    { label: translate('data_grid.view.text'), value: 'text', icon: <FileTextOutlined /> },
  ];

  return (
    <div
      data-grid-view-switcher="true"
      className="gn-v2-data-grid-result-switcher"
    >
      <Segmented
        aria-label={resultViewLabel}
        size="small"
        value={viewMode === 'json' || viewMode === 'text' ? viewMode : 'table'}
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
