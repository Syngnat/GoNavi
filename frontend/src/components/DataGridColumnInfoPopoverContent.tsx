import React from 'react';
import { Button, Checkbox, Input } from 'antd';
import { t as defaultTranslate, type I18nParams } from '../i18n';
import {
  loadGlobalHiddenColumns,
  parseGlobalHiddenColumnsText,
  saveGlobalHiddenColumns,
  serializeGlobalHiddenColumns,
  subscribeGlobalHiddenColumns,
} from '../utils/globalHiddenColumns';

export type DataGridColumnInfoTranslate = (key: string, params?: I18nParams) => string;

export interface DataGridColumnInfoPopoverContentProps {
  darkMode: boolean;
  showColumnComment: boolean;
  showColumnType: boolean;
  showRowNumberColumn: boolean;
  columnSearchText: string;
  allOrderedColumnNames: string[];
  localHiddenColumns: string[];
  enableColumnOrderMemory: boolean;
  enableHiddenColumnMemory: boolean;
  canResetOrder: boolean;
  canResetHidden: boolean;
  translate?: DataGridColumnInfoTranslate;
  onShowColumnCommentChange: (checked: boolean) => void;
  onShowColumnTypeChange: (checked: boolean) => void;
  onShowRowNumberColumnChange: (checked: boolean) => void;
  onToggleAllColumnsVisibility: (visible: boolean) => void;
  onColumnSearchTextChange: (value: string) => void;
  onToggleColumnVisibility: (columnName: string, visible: boolean) => void;
  onEnableColumnOrderMemoryChange: (checked: boolean) => void;
  onEnableHiddenColumnMemoryChange: (checked: boolean) => void;
  onResetOrder: () => void;
  onResetHidden: () => void;
}

const GLOBAL_HIDDEN_PLACEHOLDER = 'id\ncreated_by\nupdated_at';

const DataGridColumnInfoPopoverContent: React.FC<DataGridColumnInfoPopoverContentProps> = ({
  darkMode,
  showColumnComment,
  showColumnType,
  showRowNumberColumn,
  columnSearchText,
  allOrderedColumnNames,
  localHiddenColumns,
  enableColumnOrderMemory,
  enableHiddenColumnMemory,
  canResetOrder,
  canResetHidden,
  translate = defaultTranslate,
  onShowColumnCommentChange,
  onShowColumnTypeChange,
  onShowRowNumberColumnChange,
  onToggleAllColumnsVisibility,
  onColumnSearchTextChange,
  onToggleColumnVisibility,
  onEnableColumnOrderMemoryChange,
  onEnableHiddenColumnMemoryChange,
  onResetOrder,
  onResetHidden,
}) => {
  const [globalHiddenText, setGlobalHiddenText] = React.useState(() => serializeGlobalHiddenColumns(loadGlobalHiddenColumns()));

  React.useEffect(() => subscribeGlobalHiddenColumns((columns) => {
    setGlobalHiddenText(serializeGlobalHiddenColumns(columns));
  }), []);

  const saveGlobalHiddenText = React.useCallback(() => {
    setGlobalHiddenText(serializeGlobalHiddenColumns(saveGlobalHiddenColumns(parseGlobalHiddenColumnsText(globalHiddenText))));
  }, [globalHiddenText]);

  const addCurrentHiddenColumnsToGlobal = React.useCallback(() => {
    const next = [
      ...parseGlobalHiddenColumnsText(globalHiddenText),
      ...localHiddenColumns,
    ];
    setGlobalHiddenText(serializeGlobalHiddenColumns(saveGlobalHiddenColumns(next)));
  }, [globalHiddenText, localHiddenColumns]);

  const clearGlobalHiddenColumns = React.useCallback(() => {
    setGlobalHiddenText(serializeGlobalHiddenColumns(saveGlobalHiddenColumns([])));
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220, maxWidth: 320 }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: darkMode ? '#ddd' : '#666' }}>
        {translate('data_grid.column_settings.display_settings')}
      </div>
      <Checkbox checked={showColumnComment} onChange={(e) => onShowColumnCommentChange(e.target.checked)}>
        {translate('data_grid.column_settings.show_comments')}
      </Checkbox>
      <Checkbox checked={showColumnType} onChange={(e) => onShowColumnTypeChange(e.target.checked)}>
        {translate('data_grid.column_settings.show_types')}
      </Checkbox>
      <div style={{ height: 1, backgroundColor: darkMode ? '#424242' : '#f0f0f0', margin: '4px 0' }} />

      <div style={{ fontWeight: 600, fontSize: 13, color: darkMode ? '#ddd' : '#666', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{translate('data_grid.column_settings.column_visibility')}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <a style={{ fontSize: 12 }} onClick={() => onToggleAllColumnsVisibility(true)}>
            {translate('data_grid.column_settings.show_all')}
          </a>
          <a style={{ fontSize: 12 }} onClick={() => onToggleAllColumnsVisibility(false)}>
            {translate('data_grid.column_settings.hide_all')}
          </a>
        </div>
      </div>
      <Input
        placeholder={translate('data_grid.column_settings.search_columns_placeholder')}
        size="small"
        value={columnSearchText}
        onChange={(e) => onColumnSearchTextChange(e.target.value)}
        allowClear
      />
      <div className="custom-scrollbar" style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Checkbox
          checked={showRowNumberColumn}
          onChange={(e) => onShowRowNumberColumnChange(e.target.checked)}
          style={{ marginLeft: 0 }}
        >
          {translate('app.theme.data_table.row_number')}
        </Checkbox>
        {allOrderedColumnNames
          .filter((col) => !columnSearchText || col.toLowerCase().includes(columnSearchText.toLowerCase()))
          .map((col) => (
            <Checkbox
              key={col}
              checked={!localHiddenColumns.includes(col)}
              onChange={(e) => onToggleColumnVisibility(col, e.target.checked)}
              style={{ marginLeft: 0 }}
            >
              {col}
            </Checkbox>
          ))}
      </div>

      <div style={{ height: 1, backgroundColor: darkMode ? '#424242' : '#f0f0f0', margin: '4px 0' }} />
      <div style={{ fontWeight: 600, fontSize: 13, color: darkMode ? '#ddd' : '#666' }}>
        {translate('data_grid.column_settings.global_hidden_columns')}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: darkMode ? '#aaa' : '#888' }}>
        {translate('data_grid.column_settings.global_hidden_columns_help')}
      </div>
      <Input.TextArea
        autoSize={{ minRows: 2, maxRows: 4 }}
        placeholder={GLOBAL_HIDDEN_PLACEHOLDER}
        value={globalHiddenText}
        onChange={(event) => setGlobalHiddenText(event.target.value)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="small" style={{ flex: 1 }} onClick={saveGlobalHiddenText}>
          {translate('data_grid.column_settings.global_hidden_columns_apply')}
        </Button>
        <Button size="small" style={{ flex: 1 }} disabled={localHiddenColumns.length === 0} onClick={addCurrentHiddenColumnsToGlobal}>
          {translate('data_grid.column_settings.global_hidden_columns_add_current')}
        </Button>
      </div>
      <Button size="small" danger disabled={!globalHiddenText.trim()} onClick={clearGlobalHiddenColumns}>
        {translate('data_grid.column_settings.global_hidden_columns_clear')}
      </Button>

      <div style={{ height: 1, backgroundColor: darkMode ? '#424242' : '#f0f0f0', margin: '4px 0' }} />
      <Checkbox checked={enableColumnOrderMemory} onChange={(e) => onEnableColumnOrderMemoryChange(e.target.checked)}>
        {translate('data_grid.column_settings.remember_column_order')}
      </Checkbox>
      <Checkbox checked={enableHiddenColumnMemory} onChange={(e) => onEnableHiddenColumnMemoryChange(e.target.checked)}>
        {translate('data_grid.column_settings.remember_hidden_columns')}
      </Checkbox>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Button size="small" danger style={{ flex: 1 }} disabled={!canResetOrder} onClick={onResetOrder}>
          {translate('data_grid.column_settings.reset_order')}
        </Button>
        <Button size="small" danger style={{ flex: 1 }} disabled={!canResetHidden} onClick={onResetHidden}>
          {translate('data_grid.column_settings.reset_hidden')}
        </Button>
      </div>
    </div>
  );
};

export default DataGridColumnInfoPopoverContent;
