import { useId, useMemo } from 'react'
import { CopyOutlined } from '@ant-design/icons'
import { Button, Tooltip, message } from 'antd'
import {
  type ExplainNode,
  type ExplainStats,
  type IndexSuggestion,
  severityRank,
  formatNumber,
  formatPercent,
  formatMs,
} from '../../utils/explainTypes'
import { useI18n } from '../../i18n/provider'
import { describeExplainEstimate, explainActualRows, explainNeverExecuted, explainNodeTotalMs, formatStepMs } from './explainActuals'
import { explainOperationInsightKey, formatShare } from './explainPlanInsights'
import './ExplainAnalysis.css'

interface ExplainSidebarProps {
  stats: ExplainStats
  warnings?: string[]
  suggestions: IndexSuggestion[]
  selectedNode?: ExplainNode
  onSelectSuggestion?: (suggestion: IndexSuggestion) => void
  /** The plan was measured. */
  analyzed?: boolean
}

type Translate = (key: string) => string

export default function ExplainSidebar(props: ExplainSidebarProps) {
  const { stats, warnings, suggestions, selectedNode, onSelectSuggestion, analyzed } = props
  const sortedSuggestions = useMemo(
    () =>
      [...suggestions].sort((left, right) => {
        const leftRank = severityRank[left.severity] ?? 99
        const rightRank = severityRank[right.severity] ?? 99
        if (leftRank !== rightRank) return leftRank - rightRank
        return (right.estRows ?? 0) - (left.estRows ?? 0)
      }),
    [suggestions],
  )

  return (
    <aside className="gn-explain-sidebar">
      <ExplainStatsBar stats={stats} warnings={warnings} />
      {selectedNode && <ExplainNodeDetail node={selectedNode} analyzed={analyzed} />}
      <IndexSuggestionList suggestions={sortedSuggestions} onSelect={onSelectSuggestion} />
    </aside>
  )
}

function ExplainStatsBar({
  stats,
  warnings,
}: {
  stats: ExplainStats
  warnings?: string[]
}) {
  const { language, t } = useI18n()
  const titleId = useId()
  const statsList = [
    {
      label: t('sql_analysis.sidebar.stats.total_cost'),
      value: hasMetricValue(stats.totalCost) ? stats.totalCost.toFixed(1) : '-',
    },
    {
      label: t('sql_analysis.sidebar.stats.total_duration'),
      value: formatMs(stats.totalDurationMs, language),
    },
    {
      label: t('sql_analysis.sidebar.stats.rows_read'),
      value: formatNumber(stats.rowsRead, language),
    },
    {
      label: t('sql_analysis.sidebar.stats.buffer_hit'),
      value: formatPercent(stats.bufferHitRate, language),
    },
    {
      label: t('sql_analysis.sidebar.stats.max_est_rows'),
      value: formatNumber(stats.maxEstRows, language),
    },
  ]

  return (
    <section className="gn-explain-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="gn-explain-card__title">
        {t('sql_analysis.sidebar.stats.title')}
      </h3>
      <dl className="gn-explain-stats">
        {statsList.map((stat) => (
          <div key={stat.label} className="gn-explain-stats__item">
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>
      {stats.hasFullScan && (
        <WarningRow tone="danger" text={t('sql_analysis.sidebar.warning.full_scan')} />
      )}
      {stats.hasFilesort && (
        <WarningRow tone="warning" text={t('sql_analysis.sidebar.warning.filesort')} />
      )}
      {stats.hasTempTable && (
        <WarningRow tone="info" text={t('sql_analysis.sidebar.warning.temp_table')} />
      )}
      {warnings && warnings.length > 0 && (
        <ul className="gn-explain-warnings">
          {warnings.map((warning, index) => (
            <li key={`${warning}-${index}`}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

function WarningRow({
  tone,
  text,
}: {
  tone: 'danger' | 'warning' | 'info'
  text: string
}) {
  return (
    <div className={`gn-explain-warning gn-explain-warning--${tone}`}>
      <span className="gn-explain-warning__dot" aria-hidden="true" />
      {text}
    </div>
  )
}

function ExplainNodeDetail({ node, analyzed }: { node: ExplainNode; analyzed?: boolean }) {
  const { language, t } = useI18n()
  const titleId = useId()
  const rows: Array<[string, string]> = []
  rows.push([t('sql_analysis.sidebar.node.op_type'), formatExplainEnumLabel(node.opType)])
  if (node.opDetail) rows.push([t('sql_analysis.sidebar.node.op_detail'), node.opDetail])
  if (node.table) rows.push([t('sql_analysis.sidebar.node.table'), node.table])
  if (node.index) rows.push([t('sql_analysis.sidebar.node.index'), node.index])
  if (hasMetricValue(node.estRows)) {
    rows.push([t('sql_analysis.sidebar.node.est_rows'), formatNumber(node.estRows, language)])
  }
  const actualRows = explainActualRows(node, analyzed)
  if (analyzed && explainNeverExecuted(node)) {
    rows.push([t('sql_analysis.sidebar.node.actual_rows'), t('sql_analysis.explain_graph.metric.never_executed')])
  } else if (hasMetricValue(actualRows)) {
    rows.push([t('sql_analysis.sidebar.node.actual_rows'), formatNumber(actualRows, language)])
  }
  const estimate = describeExplainEstimate(node, t)
  if (estimate) rows.push([t('sql_analysis.sidebar.node.estimate'), estimate])
  if (hasMetricValue(node.loops)) {
    rows.push([t('sql_analysis.sidebar.node.loops'), formatNumber(node.loops, language)])
  }
  if (hasMetricValue(node.cost)) {
    rows.push([t('sql_analysis.sidebar.node.cost'), node.cost.toFixed(2)])
  }
  if (hasMetricValue(node.durationMs)) {
    rows.push([t('sql_analysis.sidebar.node.duration'), formatStepMs(node.durationMs, language)])
  }
  const totalMs = explainNodeTotalMs(node)
  if (totalMs !== undefined && (node.loops ?? 0) > 1) {
    rows.push([t('sql_analysis.sidebar.node.total_time'), formatStepMs(totalMs, language)])
  }
  if (hasMetricValue(node.bufferHit)) {
    rows.push([t('sql_analysis.sidebar.node.buffer_hit'), formatPercent(node.bufferHit, language)])
  }
  if (hasMetricValue(node.costShare) && node.costShare > 0) {
    rows.push([t('sql_analysis.sidebar.node.share'), t('sql_analysis.explain_hotspot.share', { share: formatShare(node.costShare) })])
  }
  if (node.flags && node.flags.length > 0) {
    rows.push([
      t('sql_analysis.sidebar.node.flags'),
      node.flags.map((flag) => localizeExplainFlag(flag, t)).join(', '),
    ])
  }

  return (
    <section className="gn-explain-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="gn-explain-card__title">
        {t('sql_analysis.sidebar.node.title')}
      </h3>
      <p className="gn-explain-insight">
        <strong>{t('sql_analysis.explain_insight.title')}</strong>
        {t(explainOperationInsightKey(String(node.opType)))}
      </p>
      <dl className="gn-explain-details">
        {rows.map(([label, value]) => (
          <div key={label} className="gn-explain-details__row">
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      {node.extra && Object.keys(node.extra).length > 0 && (
        <details className="gn-explain-extra">
          <summary>
            {t('sql_analysis.sidebar.node.extra', { count: Object.keys(node.extra).length })}
          </summary>
          <pre>{JSON.stringify(node.extra, null, 2)}</pre>
        </details>
      )}
    </section>
  )
}

function IndexSuggestionList({
  suggestions,
  onSelect,
}: {
  suggestions: IndexSuggestion[]
  onSelect?: (suggestion: IndexSuggestion) => void
}) {
  const { t } = useI18n()
  const titleId = useId()
  return (
    <section className="gn-explain-card gn-explain-suggestions" aria-labelledby={titleId}>
      <h3 id={titleId} className="gn-explain-card__title">
        {t('sql_analysis.sidebar.suggestions.title', { count: suggestions.length })}
      </h3>
      {suggestions.length === 0 ? (
        <div className="gn-explain-suggestions__empty">
          {t('sql_analysis.sidebar.suggestions.empty')}
        </div>
      ) : (
        <div className="gn-explain-suggestions__list">
          {suggestions.map((suggestion, index) => (
            <SuggestionCard
              key={`${suggestion.rule}-${suggestion.affectedNodeId ?? ''}-${index}`}
              suggestion={suggestion}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function SuggestionCard({
  suggestion,
  onSelect,
}: {
  suggestion: IndexSuggestion
  onSelect?: (suggestion: IndexSuggestion) => void
}) {
  const { language, t } = useI18n()
  const toneColor = resolveSuggestionTone(suggestion.severity)
  const copyLabel = t('data_grid.toolbar.copy')

  const copyIndexSql = async () => {
    if (!suggestion.suggestedIndex) return
    try {
      if (typeof navigator?.clipboard?.writeText !== 'function') {
        throw new Error(t('query_editor.results_panel.message.copy_unsupported'))
      }
      await navigator.clipboard.writeText(suggestion.suggestedIndex)
      void message.success(t('data_grid.message.copied_to_clipboard'))
    } catch {
      void message.error(t('connection_modal.message.copy_failed'))
    }
  }

  return (
    <article className="gn-explain-suggestion" style={{ borderLeftColor: toneColor }}>
      <button
        type="button"
        className="gn-explain-suggestion__select"
        disabled={!onSelect}
        onClick={() => onSelect?.(suggestion)}
      >
        <span className="gn-explain-suggestion__heading">
          <span className="gn-explain-suggestion__severity" style={{ color: toneColor }}>
            {localizeSuggestionSeverity(suggestion.severity, t)}
          </span>
          {hasMetricValue(suggestion.estRows) && (
            <span className="gn-explain-suggestion__rows">
              {t('sql_analysis.sidebar.suggestions.rows', {
                count: formatNumber(suggestion.estRows, language),
              })}
            </span>
          )}
        </span>
        <span className="gn-explain-suggestion__reason">{suggestion.reason}</span>
        {suggestion.affectedTable && (
          <span className="gn-explain-suggestion__table">
            {t('sql_analysis.sidebar.suggestions.table', { table: '' }).trim()}{' '}
            <code>{suggestion.affectedTable}</code>
          </span>
        )}
      </button>
      {suggestion.suggestedIndex && (
        <div className="gn-explain-suggestion__index">
          <code title={suggestion.suggestedIndex}>{suggestion.suggestedIndex}</code>
          <Tooltip title={copyLabel}>
            <Button
              type="text"
              size="small"
              className="gn-explain-suggestion__copy"
              icon={<CopyOutlined />}
              aria-label={copyLabel}
              onClick={() => void copyIndexSql()}
            />
          </Tooltip>
        </div>
      )}
    </article>
  )
}

export function hasMetricValue(value?: number): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function formatExplainEnumLabel(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
  return normalized ? normalized.charAt(0).toLocaleUpperCase() + normalized.slice(1) : '-'
}

export function localizeSuggestionSeverity(severity: string, t: Translate): string {
  switch (severity) {
    case 'critical':
      return t('security_update.severity.high')
    case 'warning':
      return t('common.warning')
    case 'info':
      return t('data_sync.log.level.info')
    default:
      return formatExplainEnumLabel(severity)
  }
}

export function localizeExplainFlag(flag: string, t: Translate): string {
  switch (flag) {
    case 'FULL_SCAN':
      return t('sql_analysis.explain_graph.flag.full_scan')
    case 'FILESORT':
      return t('sql_analysis.explain_graph.flag.filesort')
    case 'TEMP_TABLE':
      return t('sql_analysis.explain_graph.flag.temp_table')
    case 'HIGH_COST':
      return t('sql_analysis.explain_graph.flag.high_cost')
    case 'NO_INDEX':
      return t('sql_analysis.explain_graph.flag.no_index')
    case 'LOW_BUFFER_HIT':
      return t('sql_analysis.explain_graph.flag.low_buffer_hit')
    case 'UNCERTAIN_ROWS':
      return t('sql_analysis.explain_graph.flag.uncertain_rows')
    default:
      return formatExplainEnumLabel(flag)
  }
}

function resolveSuggestionTone(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'var(--gn-danger)'
    case 'warning':
      return 'var(--gn-warn)'
    case 'info':
      return 'var(--gn-info)'
    default:
      return 'var(--gn-fg-3)'
  }
}
