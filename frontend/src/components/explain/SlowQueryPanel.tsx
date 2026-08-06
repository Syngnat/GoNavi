import type { CSSProperties } from 'react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Empty,
  Input,
  Segmented,
  Spin,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd'
import Modal from '../common/ResizableDraggableModal'
import {
  CopyOutlined,
  DeleteOutlined,
  EyeOutlined,
  ImportOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { ClearSlowQueries, GetSlowQueries } from '../../../wailsjs/go/app/App'
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig'
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities'
import { useI18n } from '../../i18n/provider'
import type { ConnectionConfig } from '../../types'
import { formatMs, formatNumber } from '../../utils/explainTypes'
import { useStore } from '../../store'
import { confirmProductionMutation } from '../../utils/productionRiskConfirm'
import {
  buildSlowQuerySummary,
  filterSlowQueryRecords,
  getSlowQueryPreview,
  getSlowQuerySql,
  getVisibleSlowQueryRecords,
  isSlowQueryRecordDiagnosable,
  type SlowQueryRecord,
} from './slowQueryModel'
import './SlowQueryPanel.css'

const { Title, Text } = Typography
const INITIAL_VISIBLE_COUNT = 30
const VISIBLE_COUNT_STEP = 30
const SLOW_QUERY_THRESHOLD_MS = 500
const SLOW_QUERY_FETCH_LIMIT = 500

type SortBy = 'duration' | 'frequency' | 'rowsReturned' | 'recent'

interface SlowQueryPanelProps {
  open: boolean
  onClose: () => void
  config: ConnectionConfig
  dbName: string
  onPickQuery?: (sql: string) => void
}

interface SlowQueryPanelContentProps {
  config: ConnectionConfig
  dbName: string
  onPickQuery?: (sql: string) => void
  activeToken?: string | number | null
}

export function SlowQueryPanelContent({
  config,
  dbName,
  onPickQuery,
  activeToken,
}: SlowQueryPanelContentProps) {
  const { t, language } = useI18n()
  const { token } = theme.useToken()
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [records, setRecords] = useState<SlowQueryRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortBy>('duration')
  const [keyword, setKeyword] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const deferredKeyword = useDeferredValue(keyword)
  const requestSequenceRef = useRef(0)
  const supportsDiagnosis = getDataSourceCapabilities(config).supportsExplainDiagnosis
  const connection = useStore((state) => (
    state.connections.find((item) => item.id === config.id) || null
  ))

  const reload = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await GetSlowQueries(
        buildRpcConnectionConfig(config),
        dbName,
        sortBy,
        SLOW_QUERY_FETCH_LIMIT,
      )
      if (requestSequence !== requestSequenceRef.current) return
      if (!result.success) {
        setError(result.message || t('sql_analysis.slow_query.error.load_failed'))
        return
      }
      setRecords((result.data as SlowQueryRecord[]) ?? [])
      setVisibleCount(INITIAL_VISIBLE_COUNT)
    } catch (cause) {
      if (requestSequence === requestSequenceRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        setLoading(false)
      }
    }
  }, [config, dbName, sortBy, t])

  useEffect(() => {
    if (activeToken === null || activeToken === undefined || activeToken === '') return
    void reload()
    return () => {
      requestSequenceRef.current += 1
    }
  }, [activeToken, reload])

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }, [deferredKeyword])

  const [, setRelativeTimeTick] = useState(0)
  useEffect(() => {
    if (records.length === 0) return
    const timer = window.setInterval(() => setRelativeTimeTick((tick) => tick + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [records.length])

  const handleClear = useCallback(() => {
    Modal.confirm({
      title: t('sql_analysis.slow_query.clear_confirm.title'),
      content: t('sql_analysis.slow_query.clear_confirm.description'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!await confirmProductionMutation(
          connection,
          t('connection.production_risk.action.modify_data'),
          dbName,
          t,
        )) return
        setClearing(true)
        try {
          const result = await ClearSlowQueries(buildRpcConnectionConfig(config), dbName)
          if (!result.success) {
            throw new Error(result.message || t('sql_analysis.slow_query.error.clear_failed'))
          }
          requestSequenceRef.current += 1
          setLoading(false)
          setRecords([])
          setError(null)
          message.success(t('sql_analysis.slow_query.message.cleared'))
        } catch (cause) {
          const errorMessage = cause instanceof Error ? cause.message : String(cause)
          message.error(errorMessage || t('sql_analysis.slow_query.error.clear_failed'))
          throw cause
        } finally {
          setClearing(false)
        }
      },
    })
  }, [config, connection, dbName, t])

  const filteredRecords = useMemo(
    () => filterSlowQueryRecords(records, deferredKeyword),
    [deferredKeyword, records],
  )
  const visibleRecords = useMemo(
    () => getVisibleSlowQueryRecords(filteredRecords, visibleCount),
    [filteredRecords, visibleCount],
  )
  const summary = useMemo(() => buildSlowQuerySummary(filteredRecords), [filteredRecords])

  const panelStyle = {
    '--slow-query-bg': token.colorBgContainer,
    '--slow-query-bg-subtle': token.colorFillQuaternary,
    '--slow-query-border': token.colorBorderSecondary,
    '--slow-query-border-hover': token.colorPrimaryBorder,
    '--slow-query-text': token.colorText,
    '--slow-query-text-secondary': token.colorTextSecondary,
    '--slow-query-primary': token.colorPrimary,
    '--slow-query-error': token.colorError,
    '--slow-query-warning': token.colorWarning,
    '--slow-query-radius': `${token.borderRadiusLG}px`,
    '--slow-query-shadow': token.boxShadowTertiary,
  } as CSSProperties

  return (
    <section className="gn-slow-query-panel" style={panelStyle} aria-busy={loading}>
      <div className="gn-slow-query-toolbar">
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          prefix={<SearchOutlined aria-hidden />}
          placeholder={t('sql_analysis.slow_query.search.placeholder')}
          aria-label={t('sql_analysis.slow_query.search.aria_label')}
          name="slow-query-search"
          autoComplete="off"
          allowClear
          className="gn-slow-query-search"
        />
        <Segmented
          value={sortBy}
          onChange={(value) => setSortBy(value as SortBy)}
          aria-label={t('sql_analysis.slow_query.sort.aria_label')}
          className="gn-slow-query-sort"
          options={[
            { label: t('sql_analysis.slow_query.sort.duration'), value: 'duration' },
            { label: t('sql_analysis.slow_query.sort.frequency'), value: 'frequency' },
            { label: t('sql_analysis.slow_query.sort.rows_returned'), value: 'rowsReturned' },
            { label: t('sql_analysis.slow_query.sort.recent'), value: 'recent' },
          ]}
        />
        <div className="gn-slow-query-toolbar-actions">
          <Tooltip title={t('common.refresh')}>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => void reload()}
              loading={loading}
              aria-label={t('common.refresh')}
            />
          </Tooltip>
          <Tooltip title={t('sql_analysis.slow_query.tooltip.clear_current')}>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={handleClear}
              loading={clearing}
              disabled={records.length === 0}
              aria-label={t('sql_analysis.slow_query.tooltip.clear_current')}
            />
          </Tooltip>
        </div>
      </div>

      <div className="gn-slow-query-scope-note">
        <InfoCircleOutlined aria-hidden />
        <Text type="secondary">
          {t('sql_analysis.slow_query.scope_note', {
            threshold: SLOW_QUERY_THRESHOLD_MS,
            limit: SLOW_QUERY_FETCH_LIMIT,
          })}
        </Text>
      </div>

      {records.length > 0 && (
        <div className="gn-slow-query-summary" aria-live="polite">
          <span>{t('sql_analysis.slow_query.summary.statements', { count: summary.statementCount })}</span>
          <span>{t('sql_analysis.slow_query.summary.executions', { count: summary.executionCount })}</span>
          <span>{t('sql_analysis.slow_query.summary.max_duration', { duration: formatMs(summary.maxDurationMs, language) })}</span>
          <span>{t('sql_analysis.slow_query.summary.rows_returned', { count: formatNumber(summary.rowsReturned, language) })}</span>
        </div>
      )}

      {error && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setError(null)}
          message={t('sql_analysis.slow_query.error.title')}
          description={error}
          action={<Button size="small" onClick={() => void reload()}>{t('sql_analysis.slow_query.action.retry')}</Button>}
          className="gn-slow-query-alert"
        />
      )}

      <div className="gn-slow-query-content">
        <Spin spinning={loading} tip={t('sql_analysis.slow_query.loading')}>
          {!error && !loading && records.length === 0 && (
            <Empty description={t('sql_analysis.slow_query.empty', { threshold: SLOW_QUERY_THRESHOLD_MS })} />
          )}
          {records.length > 0 && filteredRecords.length === 0 && (
            <Empty description={t('sql_analysis.slow_query.search.empty')} />
          )}
          {visibleRecords.length > 0 && (
            <div className="gn-slow-query-list" role="list">
              {visibleRecords.map((record, index) => (
                <SlowQueryCard
                  key={record.id ?? `${record.sqlFp ?? 'slow-query'}:${index}`}
                  record={record}
                  onPickQuery={onPickQuery}
                  supportsDiagnosis={supportsDiagnosis}
                />
              ))}
            </div>
          )}
        </Spin>
        {visibleRecords.length < filteredRecords.length && (
          <Button
            block
            className="gn-slow-query-load-more"
            onClick={() => setVisibleCount((count) => count + VISIBLE_COUNT_STEP)}
          >
            {t('sql_analysis.slow_query.action.load_more', {
              shown: visibleRecords.length,
              total: filteredRecords.length,
            })}
          </Button>
        )}
      </div>
    </section>
  )
}

export default function SlowQueryPanel({ open, onClose, config, dbName, onPickQuery }: SlowQueryPanelProps) {
  const { t } = useI18n()
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1040}
      className="gn-slow-query-modal"
      title={
        <div className="gn-slow-query-modal-title">
          <ThunderboltOutlined aria-hidden />
          <Title level={5}>{t('sql_analysis.slow_query.title')}</Title>
          <Text type="secondary">{dbName || t('sql_analysis.slow_query.current_connection')}</Text>
        </div>
      }
      destroyOnHidden
    >
      <div className="gn-slow-query-modal-body">
        <SlowQueryPanelContent
          config={config}
          dbName={dbName}
          activeToken={open ? `${dbName}:open` : null}
          onPickQuery={(sql) => {
            onPickQuery?.(sql)
            onClose()
          }}
        />
      </div>
    </Modal>
  )
}

function SlowQueryCard({
  record,
  onPickQuery,
  supportsDiagnosis,
}: {
  record: SlowQueryRecord
  onPickQuery?: (sql: string) => void
  supportsDiagnosis: boolean
}) {
  const { t, language } = useI18n()
  const { token } = theme.useToken()
  const { sql, truncated } = getSlowQuerySql(record)
  const sqlPreview = getSlowQueryPreview(record)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const duration = record.maxDurationMs ?? record.durationMs ?? 0
  const rowsRead = record.maxRowsRead ?? record.rowsRead ?? 0
  const rowsReturned = record.maxRowsReturned ?? record.rowsReturned ?? 0
  const executionCount = Math.max(1, Number(record.executionCount) || 0)
  const severity = duration >= 5000 ? 'critical' : duration >= 1000 ? 'warning' : 'normal'
  const recordDiagnosable = isSlowQueryRecordDiagnosable(record)
  const canLoad = Boolean(sql && !truncated && supportsDiagnosis && recordDiagnosable && onPickQuery)
  const diagnosisHint = truncated
    ? t('sql_analysis.slow_query.truncated')
    : !supportsDiagnosis
      ? t('sql_analysis.slow_query.unsupported_diagnosis')
      : !recordDiagnosable
        ? t('sql_analysis.slow_query.not_diagnosable')
      : undefined

  const handleCopy = useCallback(async () => {
    if (!sql) return
    try {
      await navigator.clipboard.writeText(sql)
      message.success(t('sql_analysis.slow_query.message.copied'))
    } catch {
      message.error(t('sql_analysis.slow_query.error.copy_failed'))
    }
  }, [sql, t])

  return (
    <article className="gn-slow-query-card" role="listitem">
      <div className="gn-slow-query-card-header">
        <div className="gn-slow-query-metrics">
          <strong className={`gn-slow-query-duration is-${severity}`}>{formatMs(duration, language)}</strong>
          {record.avgDurationMs !== undefined && (
            <span>{t('sql_analysis.slow_query.metric.average_duration', { duration: formatMs(record.avgDurationMs, language) })}</span>
          )}
          <span>{t('sql_analysis.slow_query.metric.executions', { count: executionCount })}</span>
          {rowsRead > 0 && (
            <span>{t('sql_analysis.slow_query.metric.rows_read')} <strong>{formatNumber(rowsRead, language)}</strong></span>
          )}
          {rowsReturned > 0 && (
            <span>{t('sql_analysis.slow_query.metric.rows_returned')} <strong>{formatNumber(rowsReturned, language)}</strong></span>
          )}
        </div>
        <div className="gn-slow-query-context">
          {record.dbType && <code>{record.dbType}</code>}
          {record.executedAt && (
            <Tooltip title={formatAbsoluteTime(record.executedAt, language)}>
              <time dateTime={record.executedAt}>{formatRelativeTime(record.executedAt, t)}</time>
            </Tooltip>
          )}
        </div>
      </div>

      <pre className="gn-slow-query-sql">{sqlPreview || t('sql_analysis.slow_query.preview.empty')}</pre>

      <div className="gn-slow-query-card-footer">
        {truncated ? (
          <Text type="warning">{t('sql_analysis.slow_query.truncated')}</Text>
        ) : !supportsDiagnosis ? (
          <Text type="secondary">{t('sql_analysis.slow_query.unsupported_diagnosis')}</Text>
        ) : !recordDiagnosable ? (
          <Text type="secondary">{t('sql_analysis.slow_query.not_diagnosable')}</Text>
        ) : <span />}
        <div className="gn-slow-query-card-actions">
          {sql !== sqlPreview && (
            <Button size="small" icon={<EyeOutlined />} onClick={() => setDetailsOpen(true)}>
              {t('sql_analysis.slow_query.action.view_full')}
            </Button>
          )}
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => void handleCopy()}
            disabled={!sql}
          >
            {t('sql_analysis.slow_query.action.copy')}
          </Button>
          <Tooltip title={diagnosisHint}>
            <span>
              <Button
                size="small"
                type="primary"
                icon={<ImportOutlined />}
                onClick={() => onPickQuery?.(sql)}
                disabled={!canLoad}
              >
                {t('sql_analysis.slow_query.action.load')}
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>

      {detailsOpen && (
        <Modal
          open
          width={880}
          title={t('sql_analysis.slow_query.details.title')}
          onCancel={() => setDetailsOpen(false)}
          footer={[
            <Button key="copy" icon={<CopyOutlined />} onClick={() => void handleCopy()}>
              {t('sql_analysis.slow_query.action.copy')}
            </Button>,
            <Button key="close" type="primary" onClick={() => setDetailsOpen(false)}>
              {t('common.close')}
            </Button>,
          ]}
          destroyOnHidden
        >
          <pre
            className="gn-slow-query-full-sql"
            style={{
              background: token.colorFillQuaternary,
              borderColor: token.colorBorderSecondary,
              color: token.colorText,
            }}
          >
            {sql}
          </pre>
        </Modal>
      )}
    </article>
  )
}

function formatAbsoluteTime(isoTime: string, locale: string): string {
  const timestamp = Date.parse(isoTime)
  if (Number.isNaN(timestamp)) return isoTime
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(timestamp)
}

function formatRelativeTime(isoTime: string, t: ReturnType<typeof useI18n>['t']): string {
  const timestamp = Date.parse(isoTime)
  if (Number.isNaN(timestamp)) return ''
  const diffMs = Math.max(0, Date.now() - timestamp)
  if (diffMs < 60_000) return t('sql_analysis.slow_query.relative.just_now')
  if (diffMs < 3_600_000) {
    return t('sql_analysis.slow_query.relative.minutes_ago', { count: Math.floor(diffMs / 60_000) })
  }
  if (diffMs < 86_400_000) {
    return t('sql_analysis.slow_query.relative.hours_ago', { count: Math.floor(diffMs / 3_600_000) })
  }
  return t('sql_analysis.slow_query.relative.days_ago', { count: Math.floor(diffMs / 86_400_000) })
}
