import { Button, Typography, notification } from 'antd';
import { useCallback } from 'react';
import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import type { SavedConnection } from '../../types';
import { buildSessionWorkbenchTab } from '../../utils/sessionWorkbenchTab';
import { formatSessionDuration, truncateSessionStatement } from '../sessionWorkbench/sessionWorkbenchModel';
import type { SessionAlert, SessionAlertCheck } from './sessionAlertEvaluation';
import { recordSessionAlertCheck } from './sessionAlertHistory';
import { useSessionAlertRules } from './sessionAlertRules';
import { useSessionAlertMonitor } from './useSessionAlertMonitor';
import './SessionAlert.css';

/** Open the session workbench on the session an alert is about. */
export const openSessionAlert = (alert: SessionAlert): void => {
  useStore.getState().addTab(buildSessionWorkbenchTab({
    connectionId: alert.connectionId,
    view: alert.kind === 'lockWait' ? 'lockWaits' : 'sessions',
    filter: alert.sessionId,
    requestKey: `${alert.key}:${Date.now()}`,
  }));
};

/**
 * Always-mounted host for long-transaction and lock-wait alerts. Alerts stay
 * until dismissed: the point is to be told while looking elsewhere.
 */
export default function SessionAlertHost() {
  const { t } = useI18n();
  const connections = useStore((state) => state.connections);
  const rules = useSessionAlertRules();
  const [api, contextHolder] = notification.useNotification();

  const onAlerts = useCallback((alerts: SessionAlert[], connection: SavedConnection) => {
    alerts.forEach((alert) => {
      const duration = formatSessionDuration(alert.durationMs, t);
      const user = alert.user || t('session_workbench.value.empty');
      const lockWait = alert.kind === 'lockWait';
      api.warning({
        key: alert.key,
        duration: 0,
        placement: 'bottomRight',
        message: lockWait
          ? t('session_alerts.lock_wait.title', { connection: connection.name, duration })
          : t('session_alerts.long_transaction.title', { connection: connection.name, duration }),
        description: (
          <div className="gn-session-alert">
            <Typography.Text>
              {lockWait
                ? t('session_alerts.lock_wait.description', { session: alert.sessionId, user, count: alert.blockedCount ?? 0 })
                : t('session_alerts.long_transaction.description', {
                  session: alert.sessionId,
                  user,
                  state: alert.state || t('session_workbench.value.empty'),
                })}
              {lockWait && alert.objectName ? ` · ${t('session_alerts.object', { object: alert.objectName })}` : ''}
            </Typography.Text>
            {alert.statement ? (
              <Typography.Text type="secondary" code className="gn-session-alert-statement">
                {truncateSessionStatement(alert.statement, 140)}
              </Typography.Text>
            ) : null}
          </div>
        ),
        btn: (
          <Button
            size="small"
            type="primary"
            onClick={() => {
              openSessionAlert(alert);
              api.destroy(alert.key);
            }}
          >
            {t('session_alerts.action.view')}
          </Button>
        ),
      });
    });
  }, [api, t]);

  const onCheck = useCallback((check: SessionAlertCheck, connection: SavedConnection) => {
    recordSessionAlertCheck({ id: connection.id, name: connection.name }, check);
  }, []);

  useSessionAlertMonitor({ connections, rules, onAlerts, onCheck });
  return <>{contextHolder}</>;
}
