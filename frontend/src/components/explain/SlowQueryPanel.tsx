import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Typography, message } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useI18n } from '../../i18n/provider'
import type { ConnectionConfig } from '../../types'
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities'
import { useWorkbenchThemeStyle } from '../common/useWorkbenchThemeStyle'
import SlowQueryList from './SlowQueryList'
import SlowQueryPreview from './SlowQueryPreview'
import SlowQueryToolbar from './SlowQueryToolbar'
import { getSlowQueryKey, getSlowQuerySql, type SlowQueryRecord } from './slowQueryModel'
import { SLOW_QUERY_FETCH_LIMIT, SLOW_QUERY_THRESHOLD_MS, useSlowQueries } from './useSlowQueries'
import './SlowQueryPanel.css'

const { Text } = Typography

interface SlowQueryPanelContentProps {
  config: ConnectionConfig
  dbName: string
  onPickQuery?: (sql: string) => void
  onRestoreQuery?: (sql: string, record: SlowQueryRecord) => void
  activeToken?: string | number | null
}

/** 慢 SQL 历史：左侧按耗时/频次排序的列表，右侧选中记录的完整 SQL、指标与操作。 */
export function SlowQueryPanelContent({
  config,
  dbName,
  onPickQuery,
  onRestoreQuery,
  activeToken,
}: SlowQueryPanelContentProps) {
  const { t } = useI18n()
  const themeStyle = useWorkbenchThemeStyle()
  const supportsDiagnosis = getDataSourceCapabilities(config).supportsExplainDiagnosis
  const slowQueries = useSlowQueries({ config, dbName, activeToken })
  const { visibleRecords, filteredRecords, records, loading, error } = slowQueries
  const [selectedKeyState, setSelectedKey] = useState('')

  const selected = useMemo(() => {
    const keyed = visibleRecords.map((record, index) => ({ record, key: getSlowQueryKey(record, index) }))
    return keyed.find((item) => item.key === selectedKeyState) ?? keyed[0] ?? null
  }, [selectedKeyState, visibleRecords])

  const handlePick = useCallback((record: SlowQueryRecord) => {
    onPickQuery?.(getSlowQuerySql(record).sql)
  }, [onPickQuery])

  const handleRestore = useCallback((record: SlowQueryRecord) => {
    onRestoreQuery?.(getSlowQuerySql(record).sql, record)
  }, [onRestoreQuery])

  const handleCopy = useCallback(async (record: SlowQueryRecord) => {
    const { sql } = getSlowQuerySql(record)
    if (!sql) return
    try {
      await navigator.clipboard.writeText(sql)
      message.success(t('sql_analysis.slow_query.message.copied'))
    } catch {
      message.error(t('sql_analysis.slow_query.error.copy_failed'))
    }
  }, [t])

  const emptyDescription = error || loading
    ? null
    : records.length === 0
      ? t('sql_analysis.slow_query.empty', { threshold: SLOW_QUERY_THRESHOLD_MS })
      : filteredRecords.length === 0
        ? t('sql_analysis.slow_query.search.empty')
        : null
  const scopeNote = t('sql_analysis.slow_query.scope_note', {
    threshold: SLOW_QUERY_THRESHOLD_MS,
    limit: SLOW_QUERY_FETCH_LIMIT,
  })

  return (
    <section className="gn-sq gn-wb-theme" style={themeStyle} aria-busy={loading}>
      <SlowQueryToolbar
        keyword={slowQueries.keyword}
        sortBy={slowQueries.sortBy}
        summary={slowQueries.summary}
        hasRecords={records.length > 0}
        loading={loading}
        clearing={slowQueries.clearing}
        onKeywordChange={slowQueries.setKeyword}
        onSortChange={slowQueries.setSortBy}
        onReload={slowQueries.reload}
        onClear={slowQueries.requestClear}
      />
      <div className="gn-sq-note" title={scopeNote}>
        <InfoCircleOutlined aria-hidden />
        <Text type="secondary">{scopeNote}</Text>
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={slowQueries.dismissError}
          message={t('sql_analysis.slow_query.error.title')}
          description={error}
          action={<Button size="small" onClick={slowQueries.reload}>{t('sql_analysis.slow_query.action.retry')}</Button>}
        />
      ) : null}
      <div className="gn-sq-body">
        <SlowQueryList
          records={visibleRecords}
          totalCount={filteredRecords.length}
          loading={loading}
          emptyDescription={emptyDescription}
          selectedKey={selected?.key ?? ''}
          supportsDiagnosis={supportsDiagnosis}
          hasMore={slowQueries.hasMore}
          onShowMore={slowQueries.showMore}
          onSelect={setSelectedKey}
          onPick={onPickQuery ? handlePick : undefined}
          onRestore={onRestoreQuery ? handleRestore : undefined}
          onCopy={handleCopy}
        />
        <SlowQueryPreview
          record={selected?.record ?? null}
          supportsDiagnosis={supportsDiagnosis}
          onPick={onPickQuery ? handlePick : undefined}
          onRestore={onRestoreQuery ? handleRestore : undefined}
          onCopy={handleCopy}
        />
      </div>
    </section>
  )
}
