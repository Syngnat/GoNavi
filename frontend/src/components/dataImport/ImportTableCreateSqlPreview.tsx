import React from 'react';

export interface ImportTableCreateSqlPreviewProps {
  sql: string;
  t: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string;
}

export const ImportTableCreateSqlPreview: React.FC<ImportTableCreateSqlPreviewProps> = ({
  sql,
  t,
}) => (
  <details data-import-create-table-sql-preview="true" open>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
      {t('data_import.create_table.sql.title')}
    </summary>
    <div style={{ marginTop: 6, color: 'var(--gn-fg-3)', fontSize: 12 }}>
      {t('data_import.create_table.sql.description')}
    </div>
    <pre
      data-import-create-table-sql="true"
      style={{
        margin: '8px 0 0',
        maxHeight: 320,
        overflow: 'auto',
        padding: 12,
        borderRadius: 6,
        background: 'var(--gn-bg-subtle)',
        fontFamily: 'var(--gn-font-mono)',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
      }}
    >
      {sql}
    </pre>
  </details>
);
