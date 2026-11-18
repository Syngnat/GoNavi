import React from 'react';
import { Input } from 'antd';
import type { ImportTableCreateFormApi } from './ImportTableCreateForm';

export interface ImportTableCreateIdentityFieldsProps {
  form: ImportTableCreateFormApi;
  t: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string;
}

export const ImportTableCreateIdentityFields: React.FC<ImportTableCreateIdentityFieldsProps> = ({
  form,
  t,
}) => (
  <>
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ color: 'var(--gn-fg-3)' }}>
        {t('data_import.create_table.label.table_name')}
      </span>
      <Input
        data-import-create-table-table-name="true"
        value={form.tableName}
        maxLength={512}
        placeholder={t('data_import.create_table.placeholder.table_name')}
        status={!form.trimmedTableName ? 'error' : undefined}
        onChange={(event) => form.setTableName(event.target.value)}
      />
      {!form.trimmedTableName ? (
        <span style={{ color: 'var(--gn-danger)', fontSize: 12 }}>
          {t('data_import.create_table.validation.table_name_required')}
        </span>
      ) : null}
    </label>

    {form.showMysqlCharacterOptions ? (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--gn-fg-3)' }}>
            {t('data_import.create_table.charset')}
          </span>
          <Input
            data-import-create-table-charset="true"
            value={form.charset}
            maxLength={64}
            placeholder={t('data_import.create_table.placeholder.charset')}
            onChange={(event) => form.setCharset(event.target.value)}
          />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--gn-fg-3)' }}>
            {t('data_import.create_table.collation')}
          </span>
          <Input
            data-import-create-table-collation="true"
            value={form.collation}
            maxLength={128}
            placeholder={t('data_import.create_table.placeholder.collation')}
            onChange={(event) => form.setCollation(event.target.value)}
          />
        </label>
      </div>
    ) : null}
  </>
);
