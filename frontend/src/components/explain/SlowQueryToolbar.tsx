import { Button, Input, Segmented, Tooltip } from 'antd'
import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { useI18n } from '../../i18n/provider'
import { formatMs, formatNumber } from '../../utils/explainTypes'
import type { SlowQuerySummary } from './slowQueryModel'
import type { SlowQuerySortBy } from './useSlowQueries'

interface SlowQueryToolbarProps {
  keyword: string
  sortBy: SlowQuerySortBy
  summary: SlowQuerySummary
  hasRecords: boolean
  loading: boolean
  clearing: boolean
  onKeywordChange: (keyword: string) => void
  onSortChange: (sortBy: SlowQuerySortBy) => void
  onReload: () => void
  onClear: () => void
}

export default function SlowQueryToolbar({
  keyword,
  sortBy,
  summary,
  hasRecords,
  loading,
  clearing,
  onKeywordChange,
  onSortChange,
  onReload,
  onClear,
}: SlowQueryToolbarProps) {
  const { t, language } = useI18n()
  return (
    <div className="gn-sq-toolbar">
      <Input
        className="gn-sq-search"
        value={keyword}
        onChange={(event) => onKeywordChange(event.target.value)}
        prefix={<SearchOutlined aria-hidden />}
        placeholder={t('sql_analysis.slow_query.search.placeholder')}
        aria-label={t('sql_analysis.slow_query.search.aria_label')}
        name="slow-query-search"
        autoComplete="off"
        allowClear
      />
      <Segmented
        value={sortBy}
        onChange={(value) => onSortChange(value as SlowQuerySortBy)}
        aria-label={t('sql_analysis.slow_query.sort.aria_label')}
        className="gn-sq-sort"
        options={[
          { label: t('sql_analysis.slow_query.sort.duration'), value: 'duration' },
          { label: t('sql_analysis.slow_query.sort.frequency'), value: 'frequency' },
          { label: t('sql_analysis.slow_query.sort.rows_returned'), value: 'rowsReturned' },
          { label: t('sql_analysis.slow_query.sort.recent'), value: 'recent' },
        ]}
      />
      {hasRecords ? (
        <div className="gn-sq-summary" role="group" aria-label={t('sql_analysis.slow_query.summary.aria_label')} aria-live="polite">
          <span>{t('sql_analysis.slow_query.summary.statements', { count: summary.statementCount })}</span>
          <span>{t('sql_analysis.slow_query.summary.executions', { count: summary.executionCount })}</span>
          <span>{t('sql_analysis.slow_query.summary.max_duration', { duration: formatMs(summary.maxDurationMs, language) })}</span>
          <span>{t('sql_analysis.slow_query.summary.rows_returned', { count: formatNumber(summary.rowsReturned, language) })}</span>
        </div>
      ) : null}
      <div className="gn-sq-toolbar-actions">
        <Tooltip title={t('common.refresh')}>
          <Button icon={<ReloadOutlined />} onClick={onReload} loading={loading} aria-label={t('common.refresh')} />
        </Tooltip>
        <Tooltip title={t('sql_analysis.slow_query.tooltip.clear_current')}>
          <Button
            danger
            icon={<DeleteOutlined />}
            onClick={onClear}
            loading={clearing}
            disabled={!hasRecords}
            aria-label={t('sql_analysis.slow_query.tooltip.clear_current')}
          />
        </Tooltip>
      </div>
    </div>
  )
}
