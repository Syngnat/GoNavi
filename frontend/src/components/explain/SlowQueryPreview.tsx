import { Alert, Button, Empty, Tooltip, Typography } from 'antd'
import { CopyOutlined, FileAddOutlined, ImportOutlined } from '@ant-design/icons'
import { useI18n } from '../../i18n/provider'
import { formatMs, formatNumber } from '../../utils/explainTypes'
import { formatSlowQueryAbsoluteTime, useSlowQueryRecencyLabel } from './slowQueryFormat'
import {
  getSlowQueryDiagnosisBlocker,
  getSlowQueryDuration,
  getSlowQueryExecutionCount,
  getSlowQueryRowsRead,
  getSlowQueryRowsReturned,
  getSlowQuerySql,
  resolveSlowQueryRecency,
  resolveSlowQuerySeverity,
  type SlowQueryRecord,
} from './slowQueryModel'

const { Text } = Typography

interface SlowQueryPreviewProps {
  record: SlowQueryRecord | null
  supportsDiagnosis: boolean
  onPick?: (record: SlowQueryRecord) => void
  onRestore?: (record: SlowQueryRecord) => void
  onCopy: (record: SlowQueryRecord) => void
}

type Fact = { key: string; label: string; value: string; copyable?: boolean }

export default function SlowQueryPreview({ record, supportsDiagnosis, onPick, onRestore, onCopy }: SlowQueryPreviewProps) {
  const { t, language } = useI18n()
  const recencyLabel = useSlowQueryRecencyLabel()

  if (!record) {
    return (
      <aside className="gn-sq-preview is-empty" aria-label={t('sql_analysis.slow_query.details.title')}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sql_analysis.slow_query.preview.empty_selection')} />
      </aside>
    )
  }

  const { sql, truncated } = getSlowQuerySql(record)
  const duration = getSlowQueryDuration(record)
  const severity = resolveSlowQuerySeverity(duration)
  const blocker = getSlowQueryDiagnosisBlocker(record, supportsDiagnosis)
  const recency = resolveSlowQueryRecency(record.executedAt)
  const rowsRead = getSlowQueryRowsRead(record)
  const rowsReturned = getSlowQueryRowsReturned(record)
  const blockerText = blocker === 'truncated'
    ? t('sql_analysis.slow_query.truncated')
    : blocker === 'unsupported'
      ? t('sql_analysis.slow_query.unsupported_diagnosis')
      : blocker === 'not_diagnosable'
        ? t('sql_analysis.slow_query.not_diagnosable')
        : ''
  const executedAt = record.executedAt
    ? `${formatSlowQueryAbsoluteTime(record.executedAt, language)}${recency ? ` (${recencyLabel(recency)})` : ''}`
    : ''
  const facts: Fact[] = [
    { key: 'avg', label: t('sql_analysis.slow_query.fact.avg_duration'), value: record.avgDurationMs !== undefined ? formatMs(record.avgDurationMs, language) : '' },
    { key: 'executions', label: t('sql_analysis.slow_query.fact.executions'), value: formatNumber(getSlowQueryExecutionCount(record), language) },
    { key: 'read', label: t('sql_analysis.slow_query.fact.rows_read'), value: rowsRead > 0 ? formatNumber(rowsRead, language) : '' },
    { key: 'returned', label: t('sql_analysis.slow_query.fact.rows_returned'), value: rowsReturned > 0 ? formatNumber(rowsReturned, language) : '' },
    { key: 'dbType', label: t('sql_analysis.slow_query.fact.db_type'), value: record.dbType || '' },
    { key: 'executedAt', label: t('sql_analysis.slow_query.fact.executed_at'), value: executedAt },
    { key: 'fingerprint', label: t('sql_analysis.slow_query.fact.fingerprint'), value: record.sqlFp || '', copyable: true },
  ].filter((fact) => fact.value)

  return (
    <aside className="gn-sq-preview" aria-label={t('sql_analysis.slow_query.details.title')}>
      <header className="gn-sq-preview-head">
        <div className="gn-sq-preview-duration">
          <span className="gn-sq-preview-label">{t('sql_analysis.slow_query.fact.max_duration')}</span>
          <strong className={`gn-sq-duration is-${severity}`}>{formatMs(duration, language)}</strong>
        </div>
        <div className="gn-sq-preview-actions">
          <Tooltip title={blockerText || undefined}>
            <span>
              <Button
                type="primary"
                size="small"
                icon={<ImportOutlined aria-hidden="true" />}
                disabled={blocker !== null || !onPick}
                onClick={() => onPick?.(record)}
              >
                {t('sql_analysis.slow_query.action.load')}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={truncated ? t('query_history.insert.truncated_unavailable') : t('query_history.insert.redacted_tooltip')}>
            <span>
              <Button
                size="small"
                icon={<FileAddOutlined aria-hidden="true" />}
                disabled={!sql || truncated || !onRestore}
                onClick={() => onRestore?.(record)}
              >
                {t('query_history.insert.action')}
              </Button>
            </span>
          </Tooltip>
          <Button size="small" icon={<CopyOutlined aria-hidden="true" />} disabled={!sql} onClick={() => onCopy(record)}>
            {t('sql_analysis.slow_query.action.copy')}
          </Button>
        </div>
      </header>
      <div className="gn-sq-preview-scroll">
        <dl className="gn-sq-facts">
          {facts.map((fact) => (
            <div key={fact.key} className="gn-sq-fact">
              <dt>{fact.label}</dt>
              <dd>
                {fact.copyable
                  ? <Text copyable={{ text: fact.value }} className="gn-sq-mono" ellipsis={{ tooltip: fact.value }}>{fact.value}</Text>
                  : <span>{fact.value}</span>}
              </dd>
            </div>
          ))}
        </dl>
        {sql
          ? <pre className="gn-sq-preview-sql" aria-label={t('sql_analysis.slow_query.details.title')}>{sql}</pre>
          : <Alert type="warning" showIcon message={t('sql_analysis.slow_query.preview.empty')} />}
        {blockerText ? (
          <Alert className="gn-sq-preview-note" type={blocker === 'truncated' ? 'warning' : 'info'} showIcon message={blockerText} />
        ) : null}
      </div>
    </aside>
  )
}
