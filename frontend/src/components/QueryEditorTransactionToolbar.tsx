import React from 'react';
import { Button } from 'antd';

import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';

export type PendingSqlEditorTransaction = {
  id: string;
  commitMode: 'manual' | 'auto';
  autoCommitDelayMs: number;
  createdAt: number;
  autoCommitDueAt?: number | null;
  statementCount?: number;
  dbType?: string;
  dbName?: string;
  statements?: string[];
  executionDurationMs?: number;
};

type QueryEditorTransactionToolbarProps = {
  darkMode: boolean;
  transaction: PendingSqlEditorTransaction | null;
  autoCommitRemainingSeconds: number | null;
  onFinish: (action: 'commit' | 'rollback') => void;
};

const QueryEditorTransactionToolbar: React.FC<QueryEditorTransactionToolbarProps> = ({
  darkMode,
  transaction,
  autoCommitRemainingSeconds,
  onFinish,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;

  if (!transaction) {
    return null;
  }

  const statementCount = Math.max(0, Math.floor(Number(transaction.statementCount) || 0));
  const pendingCount = statementCount > 0 ? statementCount : 1;
  const statusText = transaction.commitMode === 'auto'
    ? autoCommitRemainingSeconds !== null && autoCommitRemainingSeconds > 0
      ? t('query_editor.transaction.status.auto_commit_countdown', { seconds: autoCommitRemainingSeconds })
      : t('query_editor.transaction.status.auto_committing')
    : null;
  const commitLabel = <>
        <span>{t('query_editor.transaction.action.commit')}</span>
        <span className="gn-v2-toolbar-kbd">{pendingCount}</span>
      </>;

  return (
    <div
      className="gn-v2-query-transaction-toolbar"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 4px',
        whiteSpace: 'nowrap',
      }}
    >
      {statusText ? (
        <span style={{ fontSize: 12, color: darkMode ? '#d4d4d4' : '#666' }}>
          {statusText}
        </span>
      ) : null}
      <Button
        className="gn-v2-query-transaction-commit-button"
        size="small"
        type="primary"
        onClick={() => onFinish('commit')}
      >
        {commitLabel}
      </Button>
      <Button
        size="small"
        danger
        onClick={() => onFinish('rollback')}
      >
        {t('query_editor.transaction.action.rollback')}
      </Button>
    </div>
  );
};

export default QueryEditorTransactionToolbar;
