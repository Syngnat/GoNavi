import { Segmented, message } from 'antd';
import { useMemo, useRef, useState } from 'react';
import type { TabData } from '../../types';
import { useI18n } from '../../i18n/provider';
import { resolveConnectionEnvironmentType } from '../../utils/connectionEnvironment';
import SessionAlertHistoryPanel from '../sessionAlerts/SessionAlertHistoryPanel';
import SessionAlertSettingsButton from '../sessionAlerts/SessionAlertSettingsButton';
import LockWaitPanel from './LockWaitPanel';
import SessionActionChooser from './SessionActionChooser';
import SessionConfirmModal from './SessionConfirmModal';
import SessionHeader from './SessionHeader';
import SessionListBody from './SessionListBody';
import SessionToolbar from './SessionToolbar';
import { displaySessionState } from './sessionStateLabel';
import { sessionDatabaseOptions } from './sessionDatabaseFilter';
import {
  filterSessions,
  sessionStateTone,
  type SessionActionRequest,
  type SessionQueryResult,
} from './sessionWorkbenchModel';
import { useLockWaits } from './useLockWaits';
import { useSessionWorkbenchDeepLink, type SessionWorkbenchView } from './useSessionWorkbenchDeepLink';
import { useSessionWorkbench } from './useSessionWorkbench';
import { useSessionWorkbenchDialogs } from './useSessionWorkbenchDialogs';
import './SessionWorkbench.css';

export interface SessionWorkbenchProps {
  tab: Pick<TabData, 'connectionId' | 'dbName' | 'sessionWorkbenchView' | 'sessionWorkbenchFilter' | 'sessionWorkbenchRequestKey'>;
  isActive?: boolean;
}

export default function SessionWorkbench({ tab, isActive }: SessionWorkbenchProps) {
  const { t } = useI18n();
  const [messageApi, messageContextHolder] = message.useMessage();
  const [view, setView] = useState<SessionWorkbenchView>('sessions');
  const workbench = useSessionWorkbench({
    initialConnectionId: tab.connectionId,
    initialDbName: tab.dbName,
  });
  useSessionWorkbenchDeepLink({ tab, workbench, setView });
  const lockWaits = useLockWaits({
    connection: workbench.selectedConnection,
    databaseName: workbench.databaseName,
    enabled: view === 'lockWaits',
    active: isActive !== false,
  });
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

  // Ending a blocker releases the sessions queued behind it, so an action
  // taken from the lock view re-reads the chains as well as the session list.
  const viewRef = useRef(view);
  viewRef.current = view;
  const refreshLockWaitsRef = useRef(lockWaits.refresh);
  refreshLockWaitsRef.current = lockWaits.refresh;
  const { executeAction } = workbench;
  const actionRunner = useMemo(() => ({
    executeAction: async (request: SessionActionRequest): Promise<SessionQueryResult> => {
      const result = await executeAction(request);
      if (result.success === true && !result.stale && viewRef.current === 'lockWaits') {
        void refreshLockWaitsRef.current();
      }
      return result;
    },
  }), [executeAction]);
  const dialogs = useSessionWorkbenchDialogs({
    capability,
    workbench: actionRunner,
    contextKey: `${workbench.selectedConnectionId}\u0000${workbench.databaseName}\u0000${workbench.scopeRevision}`,
    t,
    messageApi,
  });

  const showingLockWaits = view === 'lockWaits';
  const showingAlertHistory = view === 'alertHistory';
  const waitingCount = lockWaits.payload?.waits.length
    ? new Set(lockWaits.payload.waits.map((wait) => `${wait.waitingInstanceId ?? ''}:${wait.waitingSessionId}`)).size
    : 0;

  return (
    <div className="gn-session-workbench">
      {messageContextHolder}
      <SessionHeader
        engine={(showingLockWaits ? lockWaits.payload?.engine : undefined) || workbench.payload?.engine}
        extra={(
          <>
            <SessionAlertSettingsButton connection={workbench.selectedConnection} />
            <Segmented<SessionWorkbenchView>
              className="gn-session-workbench-view-switch"
              value={view}
              onChange={setView}
              options={[
                { value: 'sessions', label: t('session_workbench.view.sessions') },
                {
                  value: 'lockWaits',
                  label: waitingCount > 0
                    ? `${t('session_workbench.view.lock_waits')} · ${waitingCount}`
                    : t('session_workbench.view.lock_waits'),
                },
                { value: 'alertHistory', label: t('session_alerts.history.view') },
              ]}
            />
          </>
        )}
      />
      <SessionToolbar
        connections={workbench.connections}
        selectedConnectionId={workbench.selectedConnectionId}
        databaseOptions={databaseOptions}
        databaseName={workbench.databaseName}
        filter={workbench.filter}
        runningOnly={workbench.runningOnly}
        showSessionFilters={!showingLockWaits && !showingAlertHistory}
        loading={showingLockWaits ? lockWaits.loading : workbench.loading}
        databaseLoading={workbench.databasesLoading}
        onConnectionChange={workbench.setSelectedConnectionId}
        onDatabaseChange={workbench.selectDatabase}
        onFilterChange={workbench.setFilter}
        onRunningOnlyChange={workbench.setRunningOnly}
        onRefresh={() => { void (showingLockWaits ? lockWaits.refresh() : workbench.refresh()); }}
      />
      <div className="gn-session-workbench-body">
        {showingAlertHistory ? (
          <SessionAlertHistoryPanel connection={workbench.selectedConnection} />
        ) : showingLockWaits ? (
          <LockWaitPanel
            hasConnection={Boolean(workbench.selectedConnection)}
            payload={lockWaits.payload}
            loading={lockWaits.loading}
            error={lockWaits.error}
            sessionCapability={capability}
            autoRefresh={lockWaits.autoRefresh}
            onAutoRefreshChange={lockWaits.setAutoRefresh}
            onAction={dialogs.handleRowAction}
            onRetry={() => { void lockWaits.refresh(); }}
          />
        ) : (
          <SessionListBody
            workbench={workbench}
            sessions={filteredSessions}
            capability={capability}
            onAction={dialogs.handleRowAction}
          />
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
