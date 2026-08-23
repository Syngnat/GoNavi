import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Empty, Pagination, Space, Spin, Tag, Typography, message, theme } from 'antd';
import { CopyOutlined, ImportOutlined } from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';
import {
  buildSQLAuditFilterPayload,
  DEFAULT_SQL_AUDIT_FILTER,
  getSQLAuditEnumLabelKey,
  getSQLAuditRecoveryState,
  isSQLAuditEventRestorable,
  normalizeSQLAuditPage,
  sortSQLAuditTimeline,
  type SQLAuditEvent,
} from './sqlAuditModel';
import {
  requireSQLAuditMethod,
  resolveSQLAuditBackend,
  unwrapSQLAuditResult,
  type SQLAuditBackend,
} from './sqlAuditRpc';

const { Paragraph, Text, Title } = Typography;
const SQL_AUDIT_TIMELINE_PAGE_SIZE = 50;

interface SqlAuditDetailDrawerProps {
  event: SQLAuditEvent | null;
  open: boolean;
  onClose: () => void;
  backend?: SQLAuditBackend;
  connectionName?: string;
  onRestore?: (event: SQLAuditEvent) => void;
}

const resolveStatusColor = (status: string): string => {
  if (status === 'success') return 'success';
  if (status === 'error') return 'error';
  if (status === 'cancelled') return 'warning';
  return 'default';
};

export default function SqlAuditDetailDrawer({
  event,
  open,
  onClose,
  backend: backendOverride,
  connectionName,
  onRestore,
}: SqlAuditDetailDrawerProps) {
  const { t, language } = useI18n();
  const { token } = theme.useToken();
  const [timeline, setTimeline] = useState<SQLAuditEvent[]>([]);
  const [timelineTotal, setTimelineTotal] = useState(0);
  const [timelinePageSelection, setTimelinePageSelection] = useState({ eventId: '', page: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestSequenceRef = useRef(0);
  const backend = backendOverride ?? resolveSQLAuditBackend();
  const timelinePage = event && timelinePageSelection.eventId === event.id
    ? timelinePageSelection.page
    : 1;
  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
  }), [language]);

  const labelEnum = (kind: 'event_type' | 'status' | 'source', value: string): string => {
    const key = getSQLAuditEnumLabelKey(kind, value);
    return key ? t(key) : (value || t('common.unknown'));
  };

  useEffect(() => {
    if (!open || !event) {
      setTimeline([]);
      setTimelineTotal(0);
      setError('');
      setLoading(false);
      return;
    }
    if (!event.transactionId) {
      setTimeline([event]);
      setTimelineTotal(1);
      setError('');
      setLoading(false);
      return;
    }
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    setError('');
    const filter = {
      ...DEFAULT_SQL_AUDIT_FILTER,
      transactionId: event.transactionId,
      page: timelinePage,
      pageSize: SQL_AUDIT_TIMELINE_PAGE_SIZE,
    };
    let getEvents: NonNullable<SQLAuditBackend['GetSQLAuditEvents']>;
    try {
      getEvents = requireSQLAuditMethod(backend, 'GetSQLAuditEvents');
    } catch (cause) {
      setTimeline([event]);
      setTimelineTotal(1);
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
      return;
    }
    void getEvents(buildSQLAuditFilterPayload(filter))
      .then((result) => {
        if (requestSequence !== requestSequenceRef.current) return;
        const page = normalizeSQLAuditPage(unwrapSQLAuditResult(result), filter);
        setTimeline(sortSQLAuditTimeline(page.items.length > 0 ? page.items : [event]));
        setTimelineTotal(page.total || 1);
      })
      .catch((cause) => {
        if (requestSequence !== requestSequenceRef.current) return;
        setTimeline([event]);
        setTimelineTotal(1);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (requestSequence === requestSequenceRef.current) setLoading(false);
      });
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [backend, event, open, timelinePage]);

  const copyText = async (text: string, successKey: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      message.success(t(successKey));
    } catch {
      message.error(t('sql_audit.message.copy_failed'));
    }
  };

  if (!event) return null;

  const formatTimestamp = (timestamp: number): string => (
    timestamp > 0 ? dateTimeFormatter.format(new Date(timestamp)) : '-'
  );
  const statusLabel = labelEnum('status', event.status);
  const sourceLabel = labelEnum('source', event.source);
  const eventTypeLabel = labelEnum('event_type', event.eventType);
  const boundaryModeLabel = t(`sql_audit.boundary_mode.${event.boundaryMode || 'unknown'}`);
  const recoveryState = getSQLAuditRecoveryState(event);
  const restorable = isSQLAuditEventRestorable(event);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(760px, calc(100vw - 24px))"
      title={t('sql_audit.detail.title')}
      destroyOnHidden
      styles={{
        body: {
          padding: 20,
          overscrollBehavior: 'contain',
          '--sql-audit-panel': token.colorBgContainer,
          '--sql-audit-subtle': token.colorFillQuaternary,
          '--sql-audit-border': token.colorBorderSecondary,
          '--sql-audit-text': token.colorText,
          '--sql-audit-muted': token.colorTextSecondary,
          '--sql-audit-primary': token.colorPrimary,
        } as React.CSSProperties,
      }}
      extra={(
        <Space size={6} wrap>
          <Button
            size="small"
            icon={<ImportOutlined aria-hidden="true" />}
            disabled={!restorable}
            title={restorable
              ? t('query_history.restore.action')
              : t(recoveryState === 'metadata'
                ? 'query_history.restore.metadata_unavailable'
                : 'query_history.restore.event_unavailable')}
            onClick={() => onRestore?.(event)}
          >
            {t('query_history.restore.action')}
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined aria-hidden="true" />}
            onClick={() => void copyText(JSON.stringify(event, null, 2), 'sql_audit.message.json_copied')}
          >
            {t('sql_audit.action.copy_json')}
          </Button>
        </Space>
      )}
    >
      <div className="gn-sql-audit-detail">
        <section aria-labelledby="sql-audit-detail-metadata">
          <Title level={5} id="sql-audit-detail-metadata">{t('sql_audit.detail.metadata')}</Title>
          <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }}>
            <Descriptions.Item label={t('sql_audit.column.time')}>{formatTimestamp(event.timestamp)}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.column.status')}><Tag color={resolveStatusColor(event.status)}>{statusLabel}</Tag></Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.column.connection')}>{connectionName || event.connectionId || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.column.database')}>{event.database || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.column.db_type')}>{event.dbType || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.column.event_type')}>{eventTypeLabel}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.column.source')}>{sourceLabel}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.commit_mode')}>{event.commitMode || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.boundary_mode')}>{boundaryModeLabel}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.query_id')} span={2}>{event.queryId || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.transaction_id')} span={2}>{event.transactionId || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.connection_fingerprint')} span={2}>{event.connectionFingerprint || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.sql_fingerprint')} span={2}>{event.sqlFingerprint || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.column.duration')}>{event.durationMs.toLocaleString(language)} ms</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.statement_position')}>
              {event.statementCount > 0 ? `${event.statementIndex || 1} / ${event.statementCount}` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.executed_count')}>{event.executedCount > 0 ? event.executedCount.toLocaleString(language) : '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.failed_index')}>{event.failedIndex > 0 ? event.failedIndex.toLocaleString(language) : '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.outcome_unknown')}>{event.outcomeUnknown ? t('sql_audit.detail.outcome_unknown_value') : '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.rows_affected')}>{event.rowsAffected?.toLocaleString(language) ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.rows_returned')}>{event.rowsReturned?.toLocaleString(language) ?? '-'}</Descriptions.Item>
          </Descriptions>
        </section>

        <section aria-labelledby="sql-audit-detail-sql">
          <div className="gn-sql-audit-detail-heading-row">
            <Title level={5} id="sql-audit-detail-sql">{t('sql_audit.detail.sql')}</Title>
            {event.sqlRedacted ? <Tag color="processing">{t('sql_audit.detail.redacted')}</Tag> : null}
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined aria-hidden="true" />}
              disabled={!event.sqlText}
              onClick={() => void copyText(event.sqlText, 'sql_audit.message.sql_copied')}
            >
              {t('sql_audit.action.copy_sql')}
            </Button>
          </div>
          {event.sqlText ? <pre className="gn-sql-audit-detail-sql">{event.sqlText}</pre> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sql_audit.detail.no_sql')} />}
          {recoveryState === 'metadata' ? (
            <Alert type="warning" showIcon message={t('query_history.recovery.metadata')} description={t('query_history.restore.metadata_unavailable')} />
          ) : recoveryState === 'redacted' ? (
            <Alert type="info" showIcon message={t('query_history.recovery.redacted')} description={t('query_history.restore.redacted_warning')} />
          ) : null}
          {event.error ? <Alert type="error" showIcon message={t('sql_audit.detail.error')} description={event.error} /> : null}
        </section>

        <section aria-labelledby="sql-audit-detail-timeline">
          <div className="gn-sql-audit-detail-heading-row">
            <Title level={5} id="sql-audit-detail-timeline">{t('sql_audit.detail.timeline')}</Title>
            <Text type="secondary" aria-live="polite">
              {t('sql_audit.detail.timeline_page_status', { loaded: timeline.length, total: timelineTotal })}
            </Text>
          </div>
          {error ? <Alert type="warning" showIcon message={t('sql_audit.detail.timeline_partial')} description={error} style={{ marginBottom: 12 }} /> : null}
          <Spin spinning={loading}>
            <ol className="gn-sql-audit-timeline" aria-busy={loading}>
              {timeline.map((item) => (
                <li key={item.id} className={`is-${item.status}`}>
                  <div className="gn-sql-audit-timeline-header">
                    <Space size={8} wrap>
                      <Text strong>{labelEnum('event_type', item.eventType)}</Text>
                      <Tag color={resolveStatusColor(item.status)}>{labelEnum('status', item.status)}</Tag>
                      {item.statementCount > 0 ? (
                        <Text type="secondary">{t('sql_audit.detail.statement_position_value', { current: item.statementIndex || 1, total: item.statementCount })}</Text>
                      ) : null}
                    </Space>
                    <time dateTime={new Date(item.timestamp).toISOString()}>{formatTimestamp(item.timestamp)}</time>
                  </div>
                  {item.sqlText ? <pre>{item.sqlText}</pre> : null}
                  {item.error ? <Text type="danger">{item.error}</Text> : null}
                </li>
              ))}
            </ol>
          </Spin>
          {event.transactionId && timelineTotal > SQL_AUDIT_TIMELINE_PAGE_SIZE ? (
            <div className="gn-sql-audit-timeline-pagination">
              <Pagination
                size="small"
                current={timelinePage}
                pageSize={SQL_AUDIT_TIMELINE_PAGE_SIZE}
                total={timelineTotal}
                showSizeChanger={false}
                showLessItems
                onChange={(page) => setTimelinePageSelection({ eventId: event.id, page })}
                aria-label={t('sql_audit.detail.timeline_pagination_aria_label')}
              />
            </div>
          ) : null}
        </section>

        <section aria-labelledby="sql-audit-detail-integrity">
          <Title level={5} id="sql-audit-detail-integrity">{t('sql_audit.detail.integrity')}</Title>
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label={t('sql_audit.detail.sequence')}>{event.sequence.toLocaleString(language)}</Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.prev_hash')}><Paragraph copyable={{ text: event.prevHash }} className="gn-sql-audit-hash">{event.prevHash || '-'}</Paragraph></Descriptions.Item>
            <Descriptions.Item label={t('sql_audit.detail.hash')}><Paragraph copyable={{ text: event.hash }} className="gn-sql-audit-hash">{event.hash || '-'}</Paragraph></Descriptions.Item>
          </Descriptions>
        </section>
      </div>
    </Drawer>
  );
}
