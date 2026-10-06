import { Alert, Empty, Spin, Switch, Table, Typography } from 'antd';
import { useEffect, useMemo, useState, type Key, type ReactNode } from 'react';
import { useI18n } from '../../i18n/provider';
import { buildLockWaitColumns } from './lockWaitColumns';
import { buildLockWaitTree, type LockWaitPayload, type LockWaitTreeRow } from './lockWaitModel';
import {
  formatSessionDuration,
  type DatabaseSession,
  type SessionAction,
  type SessionCapability,
} from './sessionWorkbenchModel';
import './LockWaitPanel.css';

export interface LockWaitPanelProps {
  hasConnection: boolean;
  payload: LockWaitPayload | null;
  loading: boolean;
  error: string;
  /** Session actions of the same connection; terminating a blocker reuses them. */
  sessionCapability: SessionCapability;
  autoRefresh: boolean;
  onAutoRefreshChange: (autoRefresh: boolean) => void;
  onAction: (session: DatabaseSession, action: SessionAction) => void;
  onRetry: () => void;
}

function LockWaitSummary({ rows }: { rows: ReturnType<typeof buildLockWaitTree> }) {
  const { t } = useI18n();
  const { summary } = rows;
  return (
    <div className="gn-lock-wait-summary">
      <span className="gn-lock-wait-summary-item is-waiting">
        {t('session_workbench.lock.summary.waiting', { count: summary.waitingSessions })}
      </span>
      <span className="gn-lock-wait-summary-item is-root">
        {t('session_workbench.lock.summary.roots', { count: summary.rootBlockers })}
      </span>
      <span className="gn-lock-wait-summary-item">
        {t('session_workbench.lock.summary.longest', {
          duration: formatSessionDuration(summary.longestWaitMs, t),
        })}
      </span>
      {summary.hasCycle ? (
        <span className="gn-lock-wait-summary-item is-cycle">{t('session_workbench.lock.summary.cycle')}</span>
      ) : null}
    </div>
  );
}

export default function LockWaitPanel({
  hasConnection,
  payload,
  loading,
  error,
  sessionCapability,
  autoRefresh,
  onAutoRefreshChange,
  onAction,
  onRetry,
}: LockWaitPanelProps) {
  const { t } = useI18n();
  const tree = useMemo(() => buildLockWaitTree(payload?.waits ?? []), [payload]);
  const [expandedKeys, setExpandedKeys] = useState<readonly Key[]>([]);
  // Chains are short and the point is to see the whole chain at once, so
  // every refresh opens all of them; collapsing stays possible per row.
  useEffect(() => setExpandedKeys(tree.expandableKeys), [tree]);
  const columns = useMemo(
    () => buildLockWaitColumns({ t, capability: sessionCapability, onAction }),
    [onAction, sessionCapability, t],
  );

  const supported = hasConnection && Boolean(payload?.capability.supported);
  const hasRows = supported && !error && tree.rows.length > 0;
  // The summary and the auto-refresh switch share one line; the switch stays
  // reachable with nothing waiting, so the user can watch for a wait to start.
  const topline = supported ? (
    <div className="gn-lock-wait-toolbar">
      {hasRows ? <LockWaitSummary rows={tree} /> : <span />}
      <label className="gn-lock-wait-auto-refresh">
        <Switch size="small" checked={autoRefresh} onChange={onAutoRefreshChange} />
        <Typography.Text type="secondary">{t('session_workbench.lock.auto_refresh')}</Typography.Text>
      </label>
    </div>
  ) : null;

  let content: ReactNode;
  if (!hasConnection) {
    content = <Empty description={t('session_workbench.empty.no_connection')} />;
  } else if (loading && !payload) {
    content = <div className="gn-session-workbench-loading"><Spin tip={t('session_workbench.loading')} /></div>;
  } else if (error) {
    content = (
      <Alert
        type="error"
        showIcon
        message={error === 'list_failed' ? t('session_workbench.lock.error.list_failed') : error}
        action={<button type="button" onClick={onRetry}>{t('session_workbench.refresh')}</button>}
      />
    );
  } else if (!payload) {
    content = <Empty description={t('session_workbench.lock.empty.none')} />;
  } else if (!payload.capability.supported) {
    content = (
      <Empty description={t(payload.capability.reasonCode === 'not_applicable'
        ? 'session_workbench.lock.empty.not_applicable'
        : 'session_workbench.lock.empty.unsupported')}
      />
    );
  } else if (tree.rows.length === 0) {
    content = <Empty description={t('session_workbench.lock.empty.none')} />;
  } else {
    content = (
      <Table<LockWaitTreeRow>
        className="gn-session-workbench-table gn-lock-wait-table"
        size="small"
        rowKey="key"
        loading={loading}
        columns={columns}
        dataSource={tree.rows}
        pagination={false}
        tableLayout="fixed"
        rowClassName={(row) => `gn-lock-wait-row is-${row.role}`}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: setExpandedKeys,
          indentSize: 22,
        }}
      />
    );
  }

  return (
    <div className="gn-lock-wait-panel">
      {topline}
      {content}
    </div>
  );
}
