import React from 'react';
import { AutoComplete, Checkbox, Input, Switch } from 'antd';
import type { ImportTableColumnDraft } from './importTableTypeMapping';

type Translator = (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string;

interface ImportTableCreateColumnRowProps {
  column: ImportTableColumnDraft;
  typeOptions: Array<{ value: string }>;
  commentsSupported: boolean;
  t: Translator;
  onTypeChange: (key: string, value: string) => void;
  onNullableChange: (key: string, value: boolean) => void;
  onPrimaryKeyChange: (key: string, checked: boolean) => void;
  onCommentChange: (key: string, value: string) => void;
}

const ImportTableCreateColumnRow: React.FC<ImportTableCreateColumnRowProps> = ({
  column,
  typeOptions,
  commentsSupported,
  t,
  onTypeChange,
  onNullableChange,
  onPrimaryKeyChange,
  onCommentChange,
}) => (
  <tr
    data-import-create-table-column={column.name}
    style={{ borderTop: '1px solid var(--gn-br-1)' }}
  >
    <td style={{ padding: '6px 8px' }}>
      <span title={column.sourceName} style={{ fontFamily: 'var(--gn-font-mono)' }}>
        {column.name}
      </span>
      {column.sourceName !== column.name ? (
        <div style={{ color: 'var(--gn-fg-3)', fontSize: 11 }}>
          {t('data_import.create_table.column.source_name', { name: column.sourceName })}
        </div>
      ) : null}
    </td>
    <td style={{ padding: '6px 8px' }}>
      <AutoComplete
        data-import-create-table-column-type={column.name}
        value={column.type}
        options={typeOptions}
        disabled={column.timestampRequired === true}
        style={{ width: '100%' }}
        onChange={(value) => onTypeChange(column.key, String(value || ''))}
      />
    </td>
    <td style={{ padding: '6px 8px' }}>
      <Switch
        data-import-create-table-column-nullable={column.name}
        checked={column.nullable}
        disabled={column.primaryKey}
        onChange={(checked) => onNullableChange(column.key, checked)}
      />
    </td>
    <td style={{ padding: '6px 8px' }}>
      <Checkbox
        data-import-create-table-column-primary-key={column.name}
        checked={column.primaryKey}
        onChange={(event) => onPrimaryKeyChange(column.key, event.target.checked)}
      />
    </td>
    <td style={{ padding: '6px 8px' }}>
      <Input
        data-import-create-table-column-comment={column.name}
        value={column.comment}
        maxLength={1024}
        disabled={!commentsSupported}
        placeholder={commentsSupported
          ? undefined
          : t('data_import.create_table.column.comment_inline_only')}
        onChange={(event) => onCommentChange(column.key, event.target.value)}
      />
    </td>
  </tr>
);

export interface ImportTableCreateColumnsProps {
  columns: ImportTableColumnDraft[];
  typeOptions: Array<{ value: string }>;
  commentsSupported: boolean;
  t: Translator;
  onTypeChange: (key: string, value: string) => void;
  onNullableChange: (key: string, value: boolean) => void;
  onPrimaryKeyChange: (key: string, checked: boolean) => void;
  onCommentChange: (key: string, value: string) => void;
}

export const ImportTableCreateColumns: React.FC<ImportTableCreateColumnsProps> = ({
  columns,
  typeOptions,
  commentsSupported,
  t,
  onTypeChange,
  onNullableChange,
  onPrimaryKeyChange,
  onCommentChange,
}) => (
  <div>
    <div style={{ marginBottom: 8, fontWeight: 600 }}>
      {t('data_import.create_table.label.columns')}
    </div>
    <div style={{ overflowX: 'auto' }}>
      <table
        data-import-create-table-columns="true"
        style={{ width: '100%', minWidth: 920, borderCollapse: 'collapse', fontSize: 12 }}
      >
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--gn-fg-2)' }}>
            <th style={{ padding: '6px 8px' }}>{t('data_import.create_table.column.name')}</th>
            <th style={{ padding: '6px 8px', minWidth: 180 }}>{t('data_import.create_table.column.type')}</th>
            <th style={{ padding: '6px 8px', width: 90 }}>{t('data_import.create_table.column.nullable')}</th>
            <th style={{ padding: '6px 8px', width: 80 }}>{t('data_import.create_table.column.primary_key')}</th>
            <th style={{ padding: '6px 8px', minWidth: 180 }}>{t('data_import.create_table.column.comment')}</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <ImportTableCreateColumnRow
              key={column.key}
              column={column}
              typeOptions={typeOptions}
              commentsSupported={commentsSupported}
              t={t}
              onTypeChange={onTypeChange}
              onNullableChange={onNullableChange}
              onPrimaryKeyChange={onPrimaryKeyChange}
              onCommentChange={onCommentChange}
            />
          ))}
        </tbody>
      </table>
    </div>
    <div style={{ marginTop: 6, color: 'var(--gn-fg-3)', fontSize: 12 }}>
      {t('data_import.create_table.help.pk_not_null')}
    </div>
  </div>
);
