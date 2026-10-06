import { Alert, Empty, Spin } from 'antd';
import { useI18n } from '../../i18n/provider';
import SessionSummary from './SessionSummary';
import SessionTable from './SessionTable';
import type {
  DatabaseSession,
  SessionAction,
  SessionCapability,
  SessionTranslate,
} from './sessionWorkbenchModel';
import type { SessionWorkbenchState } from './useSessionWorkbench';

const errorText = (value: string, translate: SessionTranslate): string => {
  if (value === 'no_connection') return translate('session_workbench.error.no_connection');
  if (value === 'list_failed') return translate('session_workbench.error.list_failed', { detail: '' });
  if (value === 'session_workbench.error.rpc_unavailable') {
    return translate(value);
  }
  return value;
};

export interface SessionListBodyProps {
  workbench: Pick<SessionWorkbenchState, 'loading' | 'payload' | 'error' | 'selectedConnection' | 'refresh'>;
  sessions: DatabaseSession[];
  capability: SessionCapability;
  onAction: (session: DatabaseSession, action: SessionAction) => void;
}

/** The session list view: loading, error, capability and empty states, then the table. */
export default function SessionListBody({ workbench, sessions, capability, onAction }: SessionListBodyProps) {
  const { t } = useI18n();
  if (workbench.loading && !workbench.payload) {
    return <div className="gn-session-workbench-loading"><Spin tip={t('session_workbench.loading')} /></div>;
  }
  if (workbench.error) {
    return (
      <Alert
        type="error"
        showIcon
        message={errorText(workbench.error, t)}
        action={workbench.selectedConnection ? (
          <button type="button" onClick={() => { void workbench.refresh(); }}>
            {t('session_workbench.refresh')}
          </button>
        ) : undefined}
      />
    );
  }
  if (!workbench.selectedConnection) {
    return <Empty description={t('session_workbench.empty.no_connection')} />;
  }
  if (!workbench.payload?.capability.supported) {
    return (
      <Empty description={t(
        workbench.payload?.capability.reasonCode === 'not_applicable'
          ? 'session_workbench.empty.not_applicable'
          : 'session_workbench.empty.unsupported',
      )} />
    );
  }
  if (sessions.length === 0) {
    return (
      <Empty description={workbench.payload.sessions.length === 0 ? (
        // PostgreSQL-lineage servers only report the connected database's
        // sessions, so name that database: an empty list then reads as
        // "nothing in this database" instead of "the server is idle".
        workbench.payload.scopedDatabase
          ? t('session_workbench.empty.no_sessions_in_database', {
            database: workbench.payload.scopedDatabase,
          })
          : t('session_workbench.empty.no_sessions')
      ) : t('session_workbench.empty.no_match')} />
    );
  }
  return (
    <>
      <SessionSummary sessions={sessions} />
      <SessionTable
        sessions={sessions}
        capability={capability}
        loading={workbench.loading}
        onAction={onAction}
      />
    </>
  );
}
