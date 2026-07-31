import Modal from './common/ResizableDraggableModal';
import React from 'react';
import { Button, Checkbox, DatePicker, Form, Input, TimePicker, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { CopyOutlined, FormatPainterOutlined } from '@ant-design/icons';
import Editor from './MonacoEditor';
import {
  TEMPORAL_FORMATS,
  getTemporalPickerType,
  type TemporalPickerType,
} from './dataGridTemporal';
import { t as defaultTranslate, type I18nParams } from '../i18n';

export type DataGridModalsTranslate = (key: string, params?: I18nParams) => string;

type ColumnMeta = {
  type: string;
  comment: string;
};

export interface DataGridRowEditorField {
  columnName: string;
  sample: string;
  placeholder?: string;
  isJson: boolean;
  useTextArea: boolean;
  pickerType?: TemporalPickerType;
  isTemporalValue: boolean;
  isWritable: boolean;
}

export interface DataGridModalsProps {
  tableName?: string;
  darkMode: boolean;
  translate?: DataGridModalsTranslate;
  displayColumnNames: string[];
  rowEditorOpen: boolean;
  rowEditorRowKey: string;
  rowEditorForm: any;
  rowEditorFields: DataGridRowEditorField[];
  onCloseRowEditor: () => void;
  onApplyRowEditor: () => void;
  onOpenRowEditorFieldEditor: (columnName: string) => void;
  cellEditorOpen: boolean;
  cellEditorMeta: { record: Record<string, unknown>; dataIndex: string; title: string; readOnly: boolean } | null;
  cellEditorReadOnly: boolean;
  cellEditorViewerMode: boolean;
  cellEditorIsJson: boolean;
  cellEditorValue: string;
  onCloseCellEditor: () => void;
  onFormatJsonInEditor: () => void;
  onSaveCellEditor: () => void;
  onCellEditorValueChange: (value: string) => void;
  batchEditModalOpen: boolean;
  selectedCellsSize: number;
  batchEditSetNull: boolean;
  batchEditValue: string;
  onCloseBatchEditModal: () => void;
  onApplyBatchFill: () => void;
  onBatchEditSetNullChange: (checked: boolean) => void;
  onBatchEditValueChange: (value: string) => void;
  jsonEditorOpen: boolean;
  jsonEditorValue: string;
  onCloseJsonEditor: () => void;
  onFormatJsonEditor: () => void;
  onApplyJsonEditor: () => void;
  onJsonEditorValueChange: (value: string) => void;
  ddlModalOpen: boolean;
  ddlLoading: boolean;
  ddlText: string;
  onCloseDdlModal: () => void;
  onCopyDdl: () => void;
}

const DataGridModals: React.FC<DataGridModalsProps> = ({
  tableName,
  darkMode,
  translate = defaultTranslate,
  rowEditorOpen,
  rowEditorRowKey,
  rowEditorForm,
  rowEditorFields,
  onCloseRowEditor,
  onApplyRowEditor,
  onOpenRowEditorFieldEditor,
  cellEditorOpen,
  cellEditorMeta,
  cellEditorReadOnly,
  cellEditorViewerMode,
  cellEditorIsJson,
  cellEditorValue,
  onCloseCellEditor,
  onFormatJsonInEditor,
  onSaveCellEditor,
  onCellEditorValueChange,
  batchEditModalOpen,
  selectedCellsSize,
  batchEditSetNull,
  batchEditValue,
  onCloseBatchEditModal,
  onApplyBatchFill,
  onBatchEditSetNullChange,
  onBatchEditValueChange,
  jsonEditorOpen,
  jsonEditorValue,
  onCloseJsonEditor,
  onFormatJsonEditor,
  onApplyJsonEditor,
  onJsonEditorValueChange,
  ddlModalOpen,
  ddlLoading,
  ddlText,
  onCloseDdlModal,
  onCopyDdl,
}) => (
  <>
    <Modal
      title={translate('data_grid.row_editor.title')}
      open={rowEditorOpen}
      onCancel={onCloseRowEditor}
      width={980}
      destroyOnHidden
      maskClosable={false}
      footer={[
        <Button key="cancel" onClick={onCloseRowEditor}>{translate('common.cancel')}</Button>,
        <Button key="ok" type="primary" onClick={onApplyRowEditor}>{translate('data_grid.action.apply')}</Button>,
      ]}
    >
      <div style={{ marginBottom: 8, color: '#888', fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>{tableName ? `${tableName}` : ''}</span>
        <span>{rowEditorRowKey ? `rowKey: ${rowEditorRowKey}` : ''}</span>
      </div>
      <Form form={rowEditorForm} layout="vertical">
        <div className="custom-scrollbar" style={{ maxHeight: '62vh', overflow: 'auto', paddingRight: 8 }}>
          {rowEditorFields.map((field) => (
            <Form.Item key={field.columnName} label={field.columnName} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Form.Item name={field.columnName} noStyle>
                  {field.isTemporalValue && field.pickerType ? (
                    field.pickerType === 'time' ? (
                      <TimePicker
                        style={{ flex: 1, width: '100%' }}
                        format={TEMPORAL_FORMATS[field.pickerType]}
                        placeholder={field.placeholder}
                        needConfirm={false}
                        disabled={!field.isWritable}
                      />
                    ) : field.pickerType === 'datetime' ? (
                      <DatePicker
                        style={{ flex: 1, width: '100%' }}
                        showTime
                        format={TEMPORAL_FORMATS[field.pickerType]}
                        placeholder={field.placeholder}
                        needConfirm
                        disabled={!field.isWritable}
                      />
                    ) : (
                      <DatePicker
                        style={{ flex: 1, width: '100%' }}
                        format={TEMPORAL_FORMATS[field.pickerType]}
                        picker={field.pickerType as any}
                        placeholder={field.placeholder}
                        needConfirm={false}
                        disabled={!field.isWritable}
                      />
                    )
                  ) : field.useTextArea ? (
                    <Input.TextArea
                      style={{ flex: 1 }}
                      autoSize={{ minRows: field.isJson ? 4 : 1, maxRows: 10 }}
                      placeholder={field.placeholder}
                      disabled={!field.isWritable}
                    />
                  ) : (
                    <Input style={{ flex: 1 }} placeholder={field.placeholder} disabled={!field.isWritable} />
                  )}
                </Form.Item>
                <Button
                  size="small"
                  onClick={() => onOpenRowEditorFieldEditor(field.columnName)}
                  title={translate('data_grid.row_editor.popup_edit')}
                  disabled={!field.isWritable}
                >
                  ...
                </Button>
              </div>
            </Form.Item>
          ))}
        </div>
      </Form>
    </Modal>

    <Modal
      title={
        cellEditorMeta
          ? cellEditorViewerMode
            ? translate('data_grid.cell_viewer.title_with_column', { column: cellEditorMeta.title })
            : translate('data_grid.cell_editor.title_with_column', { column: cellEditorMeta.title })
          : translate('data_grid.cell_editor.title')
      }
      open={cellEditorOpen}
      onCancel={onCloseCellEditor}
      destroyOnHidden
      width={960}
      maskClosable={false}
      footer={cellEditorReadOnly
        ? [
            <Button key="close" type="primary" onClick={onCloseCellEditor}>{translate('common.close')}</Button>,
          ]
        : [
            <Button key="cancel" onClick={onCloseCellEditor}>{translate('common.cancel')}</Button>,
            <Button key="ok" type="primary" onClick={onSaveCellEditor}>{translate('common.save')}</Button>,
          ]}
    >
      <div
        data-grid-cell-editor-toolbar="true"
        style={{
          marginBottom: 8,
          color: '#888',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cellEditorMeta ? `${tableName || ''}${tableName ? '.' : ''}${cellEditorMeta.dataIndex}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {!cellEditorReadOnly && cellEditorIsJson && (
          <Tooltip title={translate('data_grid.json_editor.format')}>
            <Button
              data-grid-cell-editor-format="true"
              size="small"
              icon={<FormatPainterOutlined aria-hidden="true" />}
              aria-label={translate('data_grid.json_editor.format')}
              onClick={onFormatJsonInEditor}
            >
              {translate('data_grid.json_editor.format')}
            </Button>
          </Tooltip>
        )}
      </div>
      {cellEditorOpen && (
        <Editor
          height="56vh"
          gonaviTypography="data"
          language={cellEditorIsJson ? 'json' : 'plaintext'}
          theme={darkMode ? 'transparent-dark' : 'transparent-light'}
          value={cellEditorValue}
          onChange={(value) => onCellEditorValueChange(value || '')}
          options={{
            readOnly: cellEditorReadOnly,
            domReadOnly: cellEditorReadOnly,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            fontSize: 14,
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      )}
    </Modal>

    <Modal
      title={translate('data_grid.batch_fill.title', { count: selectedCellsSize })}
      open={batchEditModalOpen}
      onCancel={onCloseBatchEditModal}
      width={500}
      footer={[
        <Button key="cancel" onClick={onCloseBatchEditModal}>{translate('common.cancel')}</Button>,
        <Button key="ok" type="primary" onClick={onApplyBatchFill}>{translate('data_grid.action.apply')}</Button>,
      ]}
    >
      <div style={{ marginBottom: 16 }}>
        <Checkbox checked={batchEditSetNull} onChange={(event) => onBatchEditSetNullChange(event.target.checked)}>
          {translate('data_grid.batch_fill.set_null')}
        </Checkbox>
      </div>
      {!batchEditSetNull && (
        <Input.TextArea
          value={batchEditValue}
          onChange={(event) => onBatchEditValueChange(event.target.value)}
          placeholder={translate('data_grid.batch_fill.value_placeholder')}
          autoSize={{ minRows: 3, maxRows: 10 }}
          autoFocus
        />
      )}
    </Modal>

    <Modal
      title={translate('data_grid.json_editor.title')}
      open={jsonEditorOpen}
      onCancel={onCloseJsonEditor}
      destroyOnHidden
      width={980}
      maskClosable={false}
      footer={[
        <Button key="format" onClick={onFormatJsonEditor}>{translate('data_grid.json_editor.format')}</Button>,
        <Button key="cancel" onClick={onCloseJsonEditor}>{translate('common.cancel')}</Button>,
        <Button key="ok" type="primary" onClick={onApplyJsonEditor}>{translate('data_grid.json_editor.apply_changes')}</Button>,
      ]}
    >
      <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
        {translate('data_grid.json_editor.description')}
      </div>
      {jsonEditorOpen && (
        <Editor
          height="56vh"
          gonaviTypography="data"
          language="json"
          theme={darkMode ? 'transparent-dark' : 'transparent-light'}
          value={jsonEditorValue}
          onChange={(value) => onJsonEditorValueChange(value || '')}
          options={{
            readOnly: false,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            fontSize: 12,
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      )}
    </Modal>

    <Modal
      title={tableName ? `DDL - ${tableName}` : 'DDL'}
      open={ddlModalOpen}
      onCancel={onCloseDdlModal}
      destroyOnHidden
      width={960}
      footer={[
        <Button key="copy" icon={<CopyOutlined />} onClick={onCopyDdl} disabled={!ddlText.trim()}>
          {translate('data_grid.ddl.copy')}
        </Button>,
        <Button key="close" type="primary" onClick={onCloseDdlModal}>
          {translate('common.close')}
        </Button>,
      ]}
    >
      {ddlModalOpen && (
        <Editor
          height="56vh"
          gonaviTypography="sql"
          language="sql"
          theme={darkMode ? 'transparent-dark' : 'transparent-light'}
          value={ddlLoading ? translate('data_grid.ddl.loading') : ddlText}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            fontSize: 12,
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      )}
    </Modal>
  </>
);

export default DataGridModals;
