import { memo } from 'react'
import { Button, Tooltip } from 'antd'
import { CopyOutlined, FileAddOutlined, ImportOutlined } from '@ant-design/icons'
import { useI18n } from '../../i18n/provider'
import { buildSqlPreviewText } from '../../utils/sqlPreviewText'
import { formatMs, formatNumber } from '../../utils/explainTypes'
import {
  getSlowQueryDiagnosisBlocker,
  getSlowQueryDuration,
  getSlowQueryDurationRatio,
  getSlowQueryExecutionCount,
  getSlowQueryRowsRead,
  getSlowQueryRowsReturned,
  getSlowQuerySql,
  resolveSlowQueryRecency,
  resolveSlowQuerySeverity,
  type SlowQueryRecord,
} from './slowQueryModel'
import { useSlowQueryRecencyLabel } from './slowQueryFormat'

export interface SlowQueryRowActions {
  onSelect: (key: string) => void
  onPick?: (record: SlowQueryRecord) => void
  onRestore?: (record: SlowQueryRecord) => void
  onCopy: (record: SlowQueryRecord) => void
}

interface SlowQueryRowProps extends SlowQueryRowActions {
  itemKey: string
  rank: number
  record: SlowQueryRecord
  selected: boolean
  maxDurationMs: number
  supportsDiagnosis: boolean
}

export const getSlowQueryRowDomId = (key: string): string => `gn-sq-row-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`

const SQL_PREVIEW_MAX_CHARS = 700

function SlowQueryRow({
  itemKey,
  rank,
  record,
  selected,
  maxDurationMs,
  supportsDiagnosis,
  onSelect,
  onPick,
  onRestore,
  onCopy,
}: SlowQueryRowProps) {
  const { t, language } = useI18n()
  const recencyLabel = useSlowQueryRecencyLabel()
  const { sql, truncated } = getSlowQuerySql(record)
  const duration = getSlowQueryDuration(record)
  const severity = resolveSlowQuerySeverity(duration)
  const rowsRead = getSlowQueryRowsRead(record)
  const rowsReturned = getSlowQueryRowsReturned(record)
  const recency = resolveSlowQueryRecency(record.executedAt)
  const blocker = getSlowQueryDiagnosisBlocker(record, supportsDiagnosis)
  const preview = buildSqlPreviewText(record.sqlPreview || sql, SQL_PREVIEW_MAX_CHARS)
  const blockerHint = blocker === 'truncated'
    ? t('sql_analysis.slow_query.truncated')
    : blocker === 'unsupported'
      ? t('sql_analysis.slow_query.unsupported_diagnosis')
      : blocker === 'not_diagnosable'
        ? t('sql_analysis.slow_query.not_diagnosable')
        : undefined

  return (
    <div className={`gn-sq-row is-${severity}${selected ? ' is-selected' : ''}`}>
      <div
        id={getSlowQueryRowDomId(itemKey)}
        role="option"
        aria-selected={selected}
        className="gn-sq-row-main"
        onClick={() => onSelect(itemKey)}
        onDoubleClick={() => blocker === null && onPick?.(record)}
      >
        <div className="gn-sq-row-head">
          <span className="gn-sq-rank">#{rank}</span>
          {record.dbType ? <span className="gn-sq-chip">{record.dbType}</span> : null}
          <span className="gn-sq-chip">{t('sql_analysis.slow_query.metric.executions', { count: getSlowQueryExecutionCount(record) })}</span>
          {rowsRead > 0 ? (
            <span className="gn-sq-chip">{t('sql_analysis.slow_query.metric.rows_read')} {formatNumber(rowsRead, language)}</span>
          ) : null}
          {rowsReturned > 0 ? (
            <span className="gn-sq-chip">{t('sql_analysis.slow_query.metric.rows_returned')} {formatNumber(rowsReturned, language)}</span>
          ) : null}
          {recency && record.executedAt ? <time dateTime={record.executedAt}>{recencyLabel(recency)}</time> : null}
        </div>
        {preview
          ? <pre className="gn-sq-row-sql">{preview}</pre>
          : <p className="gn-sq-row-sql is-empty">{t('sql_analysis.slow_query.preview.empty')}</p>}
      </div>
      <div className="gn-sq-row-metrics">
        <strong className={`gn-sq-duration is-${severity}`}>{formatMs(duration, language)}</strong>
        {record.avgDurationMs !== undefined ? (
          <span className="gn-sq-avg">{t('sql_analysis.slow_query.metric.average_duration', { duration: formatMs(record.avgDurationMs, language) })}</span>
        ) : null}
        <span className="gn-sq-bar" aria-hidden="true">
          <i style={{ width: `${Math.round(getSlowQueryDurationRatio(duration, maxDurationMs) * 100)}%` }} />
        </span>
      </div>
      <div className="gn-sq-row-actions">
        <Tooltip title={blockerHint ?? t('sql_analysis.slow_query.action.load')}>
          <span>
            <Button
              type="text"
              size="small"
              icon={<ImportOutlined aria-hidden="true" />}
              aria-label={t('sql_analysis.slow_query.action.load')}
              disabled={blocker !== null || !onPick}
              onClick={() => onPick?.(record)}
            />
          </span>
        </Tooltip>
        <Tooltip title={truncated ? t('query_history.insert.truncated_unavailable') : t('query_history.insert.action')}>
          <span>
            <Button
              type="text"
              size="small"
              icon={<FileAddOutlined aria-hidden="true" />}
              aria-label={t('query_history.insert.action')}
              disabled={!sql || truncated || !onRestore}
              onClick={() => onRestore?.(record)}
            />
          </span>
        </Tooltip>
        <Tooltip title={t('sql_analysis.slow_query.action.copy')}>
          <span>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined aria-hidden="true" />}
              aria-label={t('sql_analysis.slow_query.action.copy')}
              disabled={!sql}
              onClick={() => onCopy(record)}
            />
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

export default memo(SlowQueryRow)
