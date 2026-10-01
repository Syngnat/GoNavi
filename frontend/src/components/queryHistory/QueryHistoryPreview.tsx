import { Alert, Button, Empty, Typography } from 'antd';
import { AuditOutlined, CopyOutlined, EditOutlined } from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';
import {
  getSQLAuditEnumLabelKey,
  getSQLAuditRecoveryState,
  isSQLAuditEventRestorable,
  type SQLAuditEvent,
} from '../audit/sqlAuditModel';
import type { QueryHistoryFormatters } from './queryHistoryFormat';
import {
  formatQueryHistoryDuration,
  resolveQueryHistoryDurationLevel,
  resolveQueryHistoryRowMetric,
} from './queryHistoryModel';

const { Text } = Typography;

interface QueryHistoryPreviewProps {
  event: SQLAuditEvent | null;
  connectionName: string;
  formatters: QueryHistoryFormatters;
  onRestore: (event: SQLAuditEvent) => void;
  onCopySql: (event: SQLAuditEvent) => void;
  onOpenAuditDetail: (event: SQLAuditEvent) => void;
}

type Fact = { key: string; label: string; value: string; copyable?: boolean; mono?: boolean };

export default function QueryHistoryPreview({
  event,
  connectionName,
  formatters,
  onRestore,
  onCopySql,
  onOpenAuditDetail,
}: QueryHistoryPreviewProps) {
  const { t } = useI18n();

  if (!event) {
    return (
      <aside className="gn-qh-preview is-empty" aria-label={t('sql_audit.detail.sql')}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('query_history.preview.empty')} />
      </aside>
    );
  }

  const statusKey = getSQLAuditEnumLabelKey('status', event.status);
  const recoveryState = getSQLAuditRecoveryState(event);
  const restorable = isSQLAuditEventRestorable(event);
  const metric = resolveQueryHistoryRowMetric(event);
  const metricLabel = metric
    ? t(metric.kind === 'returned' ? 'sql_audit.detail.rows_returned' : 'sql_audit.detail.rows_affected')
    : '';
  const facts: Fact[] = [
    { key: 'connection', label: t('sql_audit.column.connection'), value: connectionName || event.connectionId },
    { key: 'database', label: t('sql_audit.column.database'), value: event.database },
    { key: 'dbType', label: t('sql_audit.column.db_type'), value: event.dbType },
    { key: 'duration', label: t('sql_audit.column.duration'), value: formatQueryHistoryDuration(event.durationMs) },
    { key: 'rows', label: metricLabel, value: metric ? formatters.number.format(metric.count) : '' },
    {
      key: 'statement',
      label: t('sql_audit.detail.statement_position'),
      value: event.statementCount > 0 ? `${event.statementIndex || 1} / ${event.statementCount}` : '',
    },
    { key: 'queryId', label: t('sql_audit.detail.query_id'), value: event.queryId, copyable: true, mono: true },
    { key: 'transactionId', label: t('sql_audit.detail.transaction_id'), value: event.transactionId, copyable: true, mono: true },
  ].filter((fact) => fact.value);

  return (
    <aside className="gn-qh-preview" aria-label={t('sql_audit.detail.sql')}>
      <header className="gn-qh-preview-head">
        <div className="gn-qh-preview-title">
          <span className={`gn-qh-status is-${event.status}`}>{statusKey ? t(statusKey) : event.status}</span>
          <time dateTime={new Date(event.timestamp).toISOString()}>
            {formatters.dateTime.format(new Date(event.timestamp))}
          </time>
        </div>
        <div className="gn-qh-preview-actions">
          <Button
            type="primary"
            size="small"
            icon={<EditOutlined aria-hidden="true" />}
            disabled={!restorable}
            onClick={() => onRestore(event)}
          >
            {t('query_history.insert.action')}
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined aria-hidden="true" />}
            disabled={!event.sqlText}
            onClick={() => onCopySql(event)}
          >
            {t('sql_audit.action.copy_sql')}
          </Button>
          <Button size="small" icon={<AuditOutlined aria-hidden="true" />} onClick={() => onOpenAuditDetail(event)}>
            {t('query_history.preview.audit_detail')}
          </Button>
        </div>
      </header>

      <div className="gn-qh-preview-scroll">
        <section aria-label={t('query_history.preview.metrics')}>
          <dl className="gn-qh-facts">
            {facts.map((fact) => (
              <div key={fact.key} className="gn-qh-fact">
                <dt>{fact.label}</dt>
                <dd className={fact.key === 'duration' ? `gn-qh-duration is-${resolveQueryHistoryDurationLevel(event.durationMs)}` : undefined}>
                  {fact.copyable
                    ? <Text copyable={{ text: fact.value }} className="gn-qh-mono" ellipsis={{ tooltip: fact.value }}>{fact.value}</Text>
                    : <span className={fact.mono ? 'gn-qh-mono' : undefined}>{fact.value}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-label={t('sql_audit.detail.sql')}>
          {event.sqlText
            ? <pre className="gn-qh-preview-sql">{event.sqlText}</pre>
            : <Alert type="warning" showIcon message={t('query_history.text.metadata')} description={t('query_history.insert.metadata_unavailable')} />}
          {recoveryState === 'redacted' ? (
            <Alert className="gn-qh-preview-note" type="info" showIcon message={t('query_history.text.redacted')} description={t('query_history.insert.redacted_warning')} />
          ) : null}
        </section>

        {event.error ? (
          <Alert className="gn-qh-preview-note" type="error" showIcon message={t('sql_audit.detail.error')} description={<pre className="gn-qh-preview-error">{event.error}</pre>} />
        ) : null}
      </div>
    </aside>
  );
}
