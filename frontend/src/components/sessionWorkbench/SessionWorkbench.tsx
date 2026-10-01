import { Alert, Empty, Spin, message } from 'antd';
import { useMemo, useState } from 'react';
import type { TabData } from '../../types';
import { useI18n } from '../../i18n/provider';
import { resolveConnectionEnvironmentType } from '../../utils/connectionEnvironment';
import SessionActionChooser from './SessionActionChooser';
import SessionConfirmModal from './SessionConfirmModal';
import SessionHeader from './SessionHeader';
import SessionSummary from './SessionSummary';
import SessionTable from './SessionTable';
import SessionToolbar from './SessionToolbar';
import { displaySessionState } from './sessionStateLabel';
import { sessionDatabaseOptions } from './sessionDatabaseFilter';
import { filterSessions, sessionStateTone } from './sessionWorkbenchModel';
import { useSessionWorkbench } from './useSessionWorkbench';
import { useSessionWorkbenchDialogs } from './useSessionWorkbenchDialogs';
import './SessionWorkbench.css';

export interface SessionWorkbenchProps {
  tab: Pick<TabData, 'connectionId' | 'dbName'>;
  isActive?: boolean;
}

const errorText = (value: string, translate: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string): string => {
  if (value === 'no_connection') return translate('session_workbench.error.no_connection');
  if (value === 'list_failed') return translate('session_workbench.error.list_failed', { detail: '' });
  if (value === 'session_workbench.error.rpc_unavailable') {
    return translate(value);
  }
  return value;
};

export default function SessionWorkbench({ tab }: SessionWorkbenchProps) {
  const { t } = useI18n();
  const [messageApi, messageContextHolder] = message.useMessage();
  const workbench = useSessionWorkbench({
    initialConnectionId: tab.connectionId,
    initialDbName: tab.dbName,
  });
  const [runningOnly, setRunningOnly] = useState(false);
  const databaseOptions = useMemo(
    () => sessionDatabaseOptions(
      workbench.payload?.sessions || [],
      workbench.databases,
    ),
    [workbench.databases, workbench.payload?.sessions],
  );
  const filteredSessions = useMemo(
    () => {
      const scoped = workbench.runningOnly
        ? (workbench.payload?.sessions || []).filter(
          (session) => sessionStateTone(session.state) === 'active',
        )
        : (workbench.payload?.sessions || []);
      return filterSessions(scoped, workbench.filter, (state) => displaySessionState(state, t));
    },
    [t, workbench.filter, workbench.payload?.sessions, workbench.runningOnly],
  );
  const capability = workbench.payload?.capability || {
    supported: false,
    canCancelQuery: false,
    canTerminateSession: false,
  };
  const selectedConnectionName = workbench.selectedConnection?.name || '';
  const isProduction = resolveConnectionEnvironmentType(workbench.selectedConnection) === 'production';
  const dialogs = useSessionWorkbenchDialogs({
    capability,
    workbench,
    contextKey: `${workbench.selectedConnectionId}\u0000${workbench.databaseName}\u0000${workbench.scopeRevision}`,
    t,
    messageApi,
  });

  return (
    <div className="gn-session-workbench">
      {messageContextHolder}
      <SessionHeader engine={workbench.payload?.engine} />
      <SessionToolbar
        connections={workbench.connections}
        selectedConnectionId={workbench.selectedConnectionId}
        databaseOptions={databaseOptions}
        databaseName={workbench.databaseName}
        filter={workbench.filter}
        runningOnly={runningOnly}
        loading={workbench.loading}
        databaseLoading={workbench.databasesLoading}
        onConnectionChange={workbench.setSelectedConnectionId}
        onDatabaseChange={workbench.selectDatabase}
        onFilterChange={workbench.setFilter}
        onRunningOnlyChange={setRunningOnly}
        onRefresh={() => { void workbench.refresh(); }}
      />
      <div className="gn-session-workbench-body">
        {workbench.loading && !workbench.payload ? (
          <div className="gn-session-workbench-loading"><Spin tip={t('session_workbench.loading')} /></div>
        ) : workbench.error ? (
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
        ) : !workbench.selectedConnection ? (
          <Empty description={t('session_workbench.empty.no_connection')} />
        ) : !workbench.payload?.capability.supported ? (
          <Empty description={t(
            workbench.payload?.capability.reasonCode === 'not_applicable'
              ? 'session_workbench.empty.not_applicable'
              : 'session_workbench.empty.unsupported',
          )} />
        ) : filteredSessions.length === 0 ? (
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
        ) : (
          <>
            <SessionSummary sessions={filteredSessions} />
            <SessionTable
              sessions={filteredSessions}
              capability={capability}
              loading={workbench.loading}
              onAction={dialogs.handleRowAction}
            />
          </>
        )}
      </div>
      <SessionActionChooser
        open={Boolean(dialogs.chooserRow)}
        session={dialogs.chooserRow}
        capability={capability}
        onSelect={dialogs.selectAction}
        onCancel={dialogs.closeChooser}
      />
      <SessionConfirmModal
        open={Boolean(dialogs.confirmRow && dialogs.confirmAction)}
        action={dialogs.confirmAction}
        session={dialogs.confirmRow}
        capability={capability}
        connectionName={selectedConnectionName}
        production={isProduction}
        loading={workbench.loading || dialogs.confirmLoading}
        onCancel={dialogs.closeConfirmation}
        onConfirm={() => { void dialogs.handleConfirm(); }}
      />
    </div>
  );
}
