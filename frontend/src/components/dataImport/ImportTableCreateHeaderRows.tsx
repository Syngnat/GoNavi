import React, { useEffect, useState } from 'react';
import { Alert, Button, InputNumber } from 'antd';

export interface ImportTableCreateHeaderRowsProps {
  typeRow: number;
  commentRow: number;
  reinferring: boolean;
  t: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string;
  onApply: (typeRow: number, commentRow: number) => void;
}

export const ImportTableCreateHeaderRows: React.FC<ImportTableCreateHeaderRowsProps> = ({
  typeRow,
  commentRow,
  reinferring,
  t,
  onApply,
}) => {
  const [draftTypeRow, setDraftTypeRow] = useState(typeRow);
  const [draftCommentRow, setDraftCommentRow] = useState(commentRow);

  useEffect(() => {
    setDraftTypeRow(typeRow);
    setDraftCommentRow(commentRow);
  }, [commentRow, typeRow]);

  const sameRowConflict = draftTypeRow > 0 && draftTypeRow === draftCommentRow;
  const changed = draftTypeRow !== typeRow || draftCommentRow !== commentRow;
  const applyDisabled = reinferring || sameRowConflict || !changed;

  return (
    <section
      data-import-create-table-header-rows="true"
      style={{
        display: 'grid',
        gap: 8,
        padding: 12,
        border: '1px solid var(--gn-br-1)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontWeight: 600 }}>{t('data_import.create_table.header_rows.title')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ color: 'var(--gn-fg-3)', fontSize: 12 }}>
            {t('data_import.create_table.header_rows.type_row')}
          </span>
          <InputNumber
            data-import-create-table-type-row="true"
            min={0}
            max={1000}
            precision={0}
            value={draftTypeRow}
            onChange={(value) => setDraftTypeRow(Math.max(0, Math.trunc(Number(value) || 0)))}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ color: 'var(--gn-fg-3)', fontSize: 12 }}>
            {t('data_import.create_table.header_rows.comment_row')}
          </span>
          <InputNumber
            data-import-create-table-comment-row="true"
            min={0}
            max={1000}
            precision={0}
            value={draftCommentRow}
            onChange={(value) => setDraftCommentRow(Math.max(0, Math.trunc(Number(value) || 0)))}
            style={{ width: '100%' }}
          />
        </label>
        <Button
          data-import-create-table-apply-rows="true"
          loading={reinferring}
          disabled={applyDisabled}
          onClick={() => onApply(draftTypeRow, draftCommentRow)}
        >
          {t('data_import.create_table.header_rows.action')}
        </Button>
      </div>
      <div style={{ color: 'var(--gn-fg-3)', fontSize: 12 }}>
        {t('data_import.create_table.header_rows.hint')}
      </div>
      {sameRowConflict ? (
        <Alert
          data-import-create-table-header-row-error="true"
          type="error"
          showIcon
          message={t('data_import.create_table.header_rows.same_row_error')}
        />
      ) : null}
      {reinferring ? (
        <div data-import-create-table-reinferring="true" style={{ color: 'var(--gn-fg-3)', fontSize: 12 }}>
          {t('data_import.create_table.header_rows.reinferring')}
        </div>
      ) : null}
    </section>
  );
};
