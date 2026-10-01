import { memo } from 'react';
import { Button, Tooltip } from 'antd';
import { CopyOutlined, EditOutlined } from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';
import {
  getSQLAuditEnumLabelKey,
  getSQLAuditRecoveryState,
  isSQLAuditEventRestorable,
  type SQLAuditEvent,
} from '../audit/sqlAuditModel';
import type { QueryHistoryFormatters } from './queryHistoryFormat';
import {
  buildQueryHistorySqlPreview,
  formatQueryHistoryDuration,
  resolveQueryHistoryDurationLevel,
  resolveQueryHistoryRowMetric,
} from './queryHistoryModel';

interface QueryHistoryRowProps {
  event: SQLAuditEvent;
  selected: boolean;
  connectionName: string;
  formatters: QueryHistoryFormatters;
  onSelect: (eventId: string) => void;
  onRestore: (event: SQLAuditEvent) => void;
  onCopySql: (event: SQLAuditEvent) => void;
}

export const getQueryHistoryRowDomId = (eventId: string): string => `gn-qh-row-${eventId}`;

function QueryHistoryRow({
  event,
  selected,
  connectionName,
  formatters,
  onSelect,
  onRestore,
  onCopySql,
}: QueryHistoryRowProps) {
  const { t } = useI18n();
  const statusKey = getSQLAuditEnumLabelKey('status', event.status);
  const recoveryState = getSQLAuditRecoveryState(event);
  const restorable = isSQLAuditEventRestorable(event);
  const preview = buildQueryHistorySqlPreview(event.sqlText);
  const metric = resolveQueryHistoryRowMetric(event);
  const durationLevel = resolveQueryHistoryDurationLevel(event.durationMs);
  const context = [connectionName, event.database].filter(Boolean).join(' / ');
  const restoreLabel = t(recoveryState === 'metadata'
    ? 'query_history.insert.metadata_unavailable'
    : !restorable
      ? 'query_history.insert.event_unavailable'
      : recoveryState === 'redacted'
        ? 'query_history.insert.redacted_tooltip'
        : 'query_history.insert.action');

  return (
    <div className={`gn-qh-row is-${event.status}${selected ? ' is-selected' : ''}`}>
      <div
        id={getQueryHistoryRowDomId(event.id)}
        role="option"
        aria-selected={selected}
        className="gn-qh-row-main"
        onClick={() => onSelect(event.id)}
        onDoubleClick={() => onRestore(event)}
      >
        <div className="gn-qh-row-head">
          <span className={`gn-qh-status is-${event.status}`}>{statusKey ? t(statusKey) : event.status}</span>
          <time dateTime={new Date(event.timestamp).toISOString()}>{formatters.time.format(new Date(event.timestamp))}</time>
          {context ? <span className="gn-qh-row-context" title={context}>{context}</span> : null}
          {event.dbType ? <span className="gn-qh-chip">{event.dbType}</span> : null}
          {event.transactionId ? <span className="gn-qh-chip is-transaction">{t('query_history.row.transaction')}</span> : null}
          {event.statementCount > 1 ? (
            <span className="gn-qh-chip">
              {t('query_history.row.statement_position', { current: event.statementIndex || 1, total: event.statementCount })}
            </span>
          ) : null}
          {event.outcomeUnknown ? <span className="gn-qh-chip is-warning">{t('query_history.row.outcome_unknown')}</span> : null}
          {recoveryState !== 'complete' ? <span className="gn-qh-chip is-muted">{t(`query_history.text.${recoveryState}` as const)}</span> : null}
        </div>
        {preview
          ? <pre className="gn-qh-row-sql">{preview}</pre>
          : <p className="gn-qh-row-sql is-empty">{t('sql_audit.detail.no_sql')}</p>}
        {event.error ? <p className="gn-qh-row-error">{event.error}</p> : null}
      </div>
      <div className="gn-qh-row-metrics">
        <span className={`gn-qh-duration is-${durationLevel}`}>{formatQueryHistoryDuration(event.durationMs)}</span>
        {metric ? (
          <span className="gn-qh-rows">
            {t(metric.kind === 'returned' ? 'query_history.row.rows_returned' : 'query_history.row.rows_affected', {
              count: formatters.number.format(metric.count),
            })}
          </span>
        ) : null}
      </div>
      <div className="gn-qh-row-actions">
        <Tooltip title={restoreLabel}>
          <span>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined aria-hidden="true" />}
              aria-label={t('query_history.insert.action')}
              disabled={!restorable}
              onClick={() => onRestore(event)}
            />
          </span>
        </Tooltip>
        <Tooltip title={t('sql_audit.action.copy_sql')}>
          <span>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined aria-hidden="true" />}
              aria-label={t('sql_audit.action.copy_sql')}
              disabled={!event.sqlText}
              onClick={() => onCopySql(event)}
            />
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

export default memo(QueryHistoryRow);
