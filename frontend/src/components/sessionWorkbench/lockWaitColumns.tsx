import { Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SessionActions } from './SessionTable';
import { displaySessionState } from './sessionStateLabel';
import type { LockWaitTreeRow } from './lockWaitModel';
import {
  displaySessionValue,
  formatSessionDuration,
  sessionStateTone,
  type DatabaseSession,
  type SessionAction,
  type SessionCapability,
  type SessionTranslate,
} from './sessionWorkbenchModel';

const METADATA_LOCK_TYPE = 'METADATA';

function SessionCell({ row, t }: { row: LockWaitTreeRow; t: SessionTranslate }) {
  const { session } = row;
  return (
    <span className="gn-lock-wait-session">
      <span className="gn-lock-wait-session-id">
        #{session.sessionId}
        {session.instanceId ? <span className="gn-lock-wait-instance">@{session.instanceId}</span> : null}
      </span>
      <Typography.Text type="secondary" className="gn-lock-wait-session-user">
        {displaySessionValue(session.user, t)}
      </Typography.Text>
    </span>
  );
}

function StatusCell({ row, t }: { row: LockWaitTreeRow; t: SessionTranslate }) {
  const duration = formatSessionDuration(row.durationMs, t);
  return (
    <span className="gn-lock-wait-status">
      <span className="gn-lock-wait-status-tags">
        <Tag className={`gn-lock-wait-role is-${row.role}`}>
          {t(row.role === 'root' ? 'session_workbench.lock.role.root' : 'session_workbench.lock.role.waiting')}
        </Tag>
        {row.cycle ? <Tag className="gn-lock-wait-role is-cycle">{t('session_workbench.lock.cycle_marker')}</Tag> : null}
        {row.role === 'root' && row.session.state ? (
          <Tag className={`gn-session-state-tag is-${sessionStateTone(row.session.state)}`} title={row.session.state}>
            {displaySessionState(row.session.state, t)}
          </Tag>
        ) : null}
      </span>
      <Typography.Text type="secondary" className="gn-lock-wait-duration">
        {row.role === 'root'
          ? (row.durationMs === undefined ? null : t('session_workbench.lock.held', { duration }))
          : t('session_workbench.lock.waited', { duration })}
      </Typography.Text>
    </span>
  );
}

function LockCell({ row, t }: { row: LockWaitTreeRow; t: SessionTranslate }) {
  if (row.role === 'root' || !row.wait) {
    return row.blockedCount > 0
      ? <span className="gn-lock-wait-blocks">{t('session_workbench.lock.blocks', { count: row.blockedCount })}</span>
      : null;
  }
  const { wait } = row;
  const lockType = wait.lockType === METADATA_LOCK_TYPE ? t('session_workbench.lock.metadata') : wait.lockType;
  const details = [
    [lockType, wait.lockMode].filter(Boolean).join(' · '),
    wait.indexName ? t('session_workbench.lock.index', { name: wait.indexName }) : '',
    wait.blockingLockMode ? t('session_workbench.lock.holder_mode', { mode: wait.blockingLockMode }) : '',
  ].filter(Boolean);
  return (
    <span className="gn-lock-wait-lock">
      <span className="gn-lock-wait-object" title={wait.objectName}>
        {displaySessionValue(wait.objectName, t)}
      </span>
      {details.length > 0 ? (
        <Typography.Text type="secondary" className="gn-lock-wait-lock-detail">{details.join(' / ')}</Typography.Text>
      ) : null}
    </span>
  );
}

function StatementCell({ row, t }: { row: LockWaitTreeRow; t: SessionTranslate }) {
  const statement = row.session.statement;
  const shown = displaySessionValue(statement, t);
  if (!row.idleHolder) {
    return (
      <Tooltip title={statement || undefined}>
        <span className="gn-session-statement-cell">{shown}</span>
      </Tooltip>
    );
  }
  // An idle holder runs nothing; what it ran last is what is holding the lock.
  return (
    <Tooltip title={<>{t('session_workbench.lock.idle_holder')}{statement ? <><br />{statement}</> : null}</>}>
      <span className="gn-session-statement-cell is-idle-holder">
        {statement ? <span className="gn-lock-wait-last-label">{t('session_workbench.lock.last_statement')}</span> : null}
        {shown}
      </span>
    </Tooltip>
  );
}

export const buildLockWaitColumns = ({
  t,
  capability,
  onAction,
}: {
  t: SessionTranslate;
  capability: SessionCapability;
  onAction: (session: DatabaseSession, action: SessionAction) => void;
}): ColumnsType<LockWaitTreeRow> => [
  {
    title: t('session_workbench.lock.column.session'),
    key: 'session',
    width: 170,
    render: (_value, row) => <SessionCell row={row} t={t} />,
  },
  {
    title: t('session_workbench.lock.column.status'),
    key: 'status',
    width: 190,
    render: (_value, row) => <StatusCell row={row} t={t} />,
  },
  {
    title: t('session_workbench.lock.column.lock'),
    key: 'lock',
    width: 280,
    render: (_value, row) => <LockCell row={row} t={t} />,
  },
  {
    title: t('session_workbench.lock.column.statement'),
    key: 'statement',
    render: (_value, row) => <StatementCell row={row} t={t} />,
  },
  {
    title: t('session_workbench.lock.column.actions'),
    key: 'actions',
    width: 120,
    render: (_value, row) => (
      <SessionActions session={row.session} capability={capability} onAction={onAction} label={t} />
    ),
  },
];
