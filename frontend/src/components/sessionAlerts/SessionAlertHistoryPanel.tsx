import { useMemo, useState } from 'react';
import { Button, Empty, Popconfirm, Switch, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useI18n } from '../../i18n/provider';
import type { SavedConnection } from '../../types';
import { formatSessionDuration, truncateSessionStatement } from '../sessionWorkbench/sessionWorkbenchModel';
import { isSessionAlertRuleActive } from './sessionAlertEvaluation';
import {
  clearSessionAlertHistory,
  SESSION_ALERT_RECORD_STALE_MS,
  useSessionAlertHistory,
  type SessionAlertRecord,
} from './sessionAlertHistory';
import { useSessionAlertRules } from './sessionAlertRules';
import { openSessionAlert } from './SessionAlertHost';
import './SessionAlert.css';

const { Text } = Typography;

type RecordStatus = 'ongoing' | 'unchecked' | 'ended' | 'endedUnobserved';

export const sessionAlertRecordStatus = (record: SessionAlertRecord, now: number): RecordStatus => {
  if (record.endedAt !== undefined) return record.endUnobserved ? 'endedUnobserved' : 'ended';
  return now - record.lastSeenAt > SESSION_ALERT_RECORD_STALE_MS ? 'unchecked' : 'ongoing';
};

const STATUS_KEY: Record<RecordStatus, string> = {
  ongoing: 'ongoing', unchecked: 'unchecked', ended: 'ended', endedUnobserved: 'ended_unobserved',
};

/** Past long-transaction and lock-wait alerts: who held things up, when, and for how long. */
export default function SessionAlertHistoryPanel({ connection }: { connection: SavedConnection | null }) {
  const { language, t } = useI18n();
  const records = useSessionAlertHistory();
  const rules = useSessionAlertRules();
  const [allConnections, setAllConnections] = useState(false);
  const formatTime = useMemo(() => {
    const format = new Intl.DateTimeFormat(language, {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    return (value: number) => format.format(new Date(value));
  }, [language]);
  const connectionId = connection?.id ?? '';
  const visible = useMemo(
    () => records.filter((record) => allConnections || record.connectionId === connectionId),
    [allConnections, connectionId, records],
  );
  const now = Date.now();

  const columns: ColumnsType<SessionAlertRecord> = [
    {
      title: t('session_alerts.history.column.started'),
      key: 'started',
      width: 140,
      render: (_value, record) => formatTime(record.startedAt),
    },
    {
      title: t('session_alerts.history.column.kind'),
      key: 'kind',
      width: 96,
      render: (_value, record) => (
        <span className={`gn-session-alert-history__kind is-${record.kind}`}>
          {t(record.kind === 'lockWait' ? 'session_alerts.history.kind.lock_wait' : 'session_alerts.history.kind.long_transaction')}
        </span>
      ),
    },
    ...(allConnections ? [{
      title: t('session_alerts.history.column.connection'),
      key: 'connection',
      width: 140,
      ellipsis: true,
      render: (_value: unknown, record: SessionAlertRecord) => record.connectionName || record.connectionId,
    }] : []),
    {
      title: t('session_alerts.history.column.session'),
      key: 'session',
      width: 130,
      render: (_value, record) => (
        <span className="gn-session-alert-history__session">
          <strong>#{record.sessionId}</strong>
          {record.user ? <Text type="secondary">{record.user}</Text> : null}
        </span>
      ),
    },
    {
      title: t('session_alerts.history.column.duration'),
      key: 'duration',
      width: 110,
      render: (_value, record) => (
        <span title={t('session_alerts.history.duration_hint')}>{formatSessionDuration(record.peakDurationMs, t)}</span>
      ),
    },
    {
      title: t('session_alerts.history.column.status'),
      key: 'status',
      width: 150,
      render: (_value, record) => {
        const status = sessionAlertRecordStatus(record, now);
        return (
          <span className={`gn-session-alert-history__status is-${status}`}>
            {t(`session_alerts.history.status.${STATUS_KEY[status]}`, {
              time: formatTime(record.endedAt ?? record.lastSeenAt),
            })}
          </span>
        );
      },
    },
    {
      title: t('session_alerts.history.column.detail'),
      key: 'detail',
      ellipsis: true,
      render: (_value, record) => (
        <span className="gn-session-alert-history__detail">
          {record.kind === 'lockWait' ? (
            <Text>
              {t('session_alerts.history.blocked', { count: record.blockedCount ?? 0 })}
              {record.objectName ? ` · ${t('session_alerts.object', { object: record.objectName })}` : ''}
            </Text>
          ) : null}
          {record.statement ? (
            <Text type="secondary" code title={record.statement}>{truncateSessionStatement(record.statement, 160)}</Text>
          ) : null}
        </span>
      ),
    },
    {
      title: '',
      key: 'action',
      width: 72,
      render: (_value, record) => (sessionAlertRecordStatus(record, now) === 'ongoing' ? (
        <Button
          size="small"
          type="link"
          onClick={() => openSessionAlert({
            key: record.key,
            kind: record.kind,
            connectionId: record.connectionId,
            sessionId: record.sessionId,
            durationMs: record.peakDurationMs,
          })}
        >
          {t('session_alerts.action.view')}
        </Button>
      ) : null),
    },
  ];

  return (
    <div className="gn-session-alert-history">
      <div className="gn-session-alert-history__bar">
        <Text type="secondary">{t('session_alerts.history.summary', { count: visible.length })}</Text>
        <label className="gn-session-alert-history__all">
          <Switch size="small" checked={allConnections} onChange={setAllConnections} />
          {t('session_alerts.history.all_connections')}
        </label>
        <Popconfirm
          title={t(allConnections ? 'session_alerts.history.clear_all_confirm' : 'session_alerts.history.clear_confirm')}
          onConfirm={() => clearSessionAlertHistory(allConnections ? undefined : connectionId)}
          disabled={visible.length === 0}
        >
          <Button size="small" disabled={visible.length === 0}>{t('session_alerts.history.clear')}</Button>
        </Popconfirm>
      </div>
      {!allConnections && connection && !isSessionAlertRuleActive(rules[connection.id]) ? (
        <Text type="secondary" className="gn-session-alert-history__hint">{t('session_alerts.history.not_enabled')}</Text>
      ) : null}
      <Table<SessionAlertRecord>
        className="gn-session-alert-history__table"
        size="small"
        rowKey="id"
        tableLayout="fixed"
        pagination={visible.length > 50 ? { pageSize: 50, size: 'small' } : false}
        columns={columns}
        dataSource={visible as SessionAlertRecord[]}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('session_alerts.history.empty')} /> }}
      />
    </div>
  );
}
