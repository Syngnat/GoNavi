import React from 'react';
import { AutoComplete, Input, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { t as defaultTranslate, type I18nParams } from '../i18n';

export type DataGridColumnQuickFindTranslate = (key: string, params?: I18nParams) => string;

export interface DataGridColumnQuickFindProps {
  inputProps?: Record<string, unknown>;
  value: string;
  options: Array<{ value: string; label?: React.ReactNode }>;
  translate?: DataGridColumnQuickFindTranslate;
  onChange: (value: string) => void;
  onSubmit: (value?: string) => void;
}

const DataGridColumnQuickFind: React.FC<DataGridColumnQuickFindProps> = ({
  inputProps,
  value,
  options,
  translate = defaultTranslate,
  onChange,
  onSubmit,
}) => {
  return (
    <Tooltip title={translate('data_grid.column_quick_find.tooltip')}>
      <div
        data-grid-column-quick-find="true"
        className="gn-v2-data-grid-column-quick-find"
      >
        <div
          className="gn-v2-data-grid-column-quick-find-row"
        >
          <div className="gn-v2-data-grid-column-quick-find-field">
            <AutoComplete
              className="gn-v2-data-grid-column-quick-find-autocomplete"
              options={options}
              value={value}
              onChange={onChange}
              onSelect={(nextValue) => {
                onChange(nextValue);
                onSubmit(nextValue);
              }}
              filterOption={false}
              popupMatchSelectWidth={280}
            >
              <Input
                {...inputProps}
                allowClear
                size="small"
                variant="borderless"
                prefix={<SearchOutlined />}
                placeholder={translate('data_grid.column_quick_find.placeholder')}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onPressEnter={() => onSubmit(value)}
              />
            </AutoComplete>
          </div>
        </div>
      </div>
    </Tooltip>
  );
};

export default DataGridColumnQuickFind;
