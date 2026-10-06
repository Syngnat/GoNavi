import { memo } from 'react'
import { Handle, Position } from 'reactflow'
import { formatNumber, type ExplainNode } from '../../utils/explainTypes'
import { useI18n } from '../../i18n/provider'
import {
  describeExplainEstimate,
  explainActualRows,
  explainNeverExecuted,
  explainNodeTotalMs,
  formatStepMs,
  isExplainMisestimated,
} from './explainActuals'
import { explainHeatLevel, explainOperationKindKey, formatCompactRows, formatShare, type ExplainLayoutDirection } from './explainPlanInsights'
import './ExplainPlanInsights.css'

export interface ExplainGraphNodeData {
  node: ExplainNode
  isSelected: boolean
  onSelect?: (nodeId: string) => void
  direction?: ExplainLayoutDirection
  /** On the chain from the costliest step up to the result. */
  onHotPath?: boolean
  /** The plan was measured. */
  analyzed?: boolean
}

function FlagBadge({ tone, text }: { tone: 'danger' | 'warning' | 'info'; text: string }) {
  return <span className={`gn-explain-flag gn-explain-flag--${tone}`}>{text}</span>
}

function isFiniteMetric(value?: number): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function formatOperationLabel(operation: string): string {
  const normalized = String(operation || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
  return normalized ? normalized.charAt(0).toLocaleUpperCase() + normalized.slice(1) : '-'
}

export function resolveOperationColor(operation: string): string {
  switch (operation) {
    case 'SCAN':
    case 'MATERIALIZE':
      return 'var(--gn-danger)'
    case 'INDEX_SCAN':
    case 'INDEX_ONLY':
      return 'var(--gn-accent)'
    case 'JOIN':
    case 'AGGREGATE':
    case 'SUBQUERY':
    case 'UNION':
    case 'WINDOW':
      return 'var(--gn-info)'
    case 'SORT':
      return 'var(--gn-warn)'
    default:
      return 'var(--gn-fg-3)'
  }
}

function NodeMetrics({ node, analyzed }: { node: ExplainNode; analyzed?: boolean }) {
  const { language, t } = useI18n()
  const never = analyzed && explainNeverExecuted(node)
  const actualRows = never ? undefined : explainActualRows(node, analyzed)
  const totalMs = explainNodeTotalMs(node)
  const loops = node.loops ?? 0
  return (
    <span className="gn-explain-node__metrics">
      {isFiniteMetric(node.estRows) && (
        <span>
          {t('sql_analysis.explain_graph.metric.est_rows')}{' '}
          <strong>{formatNumber(node.estRows, language)}</strong>
        </span>
      )}
      {never && <span className="gn-explain-node__never">{t('sql_analysis.explain_graph.metric.never_executed')}</span>}
      {isFiniteMetric(actualRows) && (
        <span className={isExplainMisestimated(node) ? 'gn-explain-node__actual is-misestimated' : 'gn-explain-node__actual'}>
          {t('sql_analysis.explain_graph.metric.actual_rows')}{' '}
          <strong>{formatNumber(actualRows, language)}</strong>
          {loops > 1 ? ` ${t('sql_analysis.explain_graph.metric.loops', { count: formatCompactRows(loops, language) })}` : null}
        </span>
      )}
      {analyzed && totalMs !== undefined && (
        <span>
          {t('sql_analysis.explain_graph.metric.time')}{' '}
          <strong>{formatStepMs(totalMs, language)}</strong>
        </span>
      )}
      {!analyzed && isFiniteMetric(node.cost) && (
        <span>
          {t('sql_analysis.explain_graph.metric.cost')}{' '}
          <strong>{node.cost?.toFixed(1)}</strong>
        </span>
      )}
    </span>
  )
}

export const ExplainGraphNodeRenderer = memo(function ExplainGraphNodeRenderer({
  data,
}: {
  data: ExplainGraphNodeData
}) {
  const { t } = useI18n()
  const { node, isSelected, onSelect, direction = 'TB', onHotPath, analyzed } = data
  const misestimate = isExplainMisestimated(node) ? describeExplainEstimate(node, t) : null
  const operationColor = resolveOperationColor(node.opType)
  const flags = new Set<string>(node.flags ?? [])
  const operationLabel = node.opDetail || formatOperationLabel(node.opType)
  const heat = explainHeatLevel(node.costShare)
  const share = node.costShare ?? 0
  const horizontal = direction === 'LR'

  return (
    <button
      type="button"
      className={`gn-explain-node gn-explain-node--heat-${heat}${isSelected ? ' gn-explain-node--selected' : ''}${onHotPath ? ' gn-explain-node--hot-path' : ''}`}
      style={{ borderColor: isSelected ? 'var(--gn-accent)' : operationColor }}
      aria-pressed={isSelected}
      title={operationLabel}
      onClick={(event) => {
        event.stopPropagation()
        onSelect?.(node.id)
      }}
    >
      <Handle type="target" position={horizontal ? Position.Right : Position.Top} isConnectable={false} />
      <span className="gn-explain-node__label" style={{ color: operationColor }} title={operationLabel}>
        {node.opType !== 'OTHER' ? (
          <span className="gn-explain-node__kind">{t(explainOperationKindKey(node.opType))}</span>
        ) : null}
        {operationLabel}
      </span>
      {share > 0 && (
        <span className="gn-explain-node__share" title={t('sql_analysis.explain_graph.metric.share')}>
          <span className="gn-explain-node__share-track">
            <span className="gn-explain-node__share-fill" style={{ width: `${Math.max(2, share * 100)}%` }} />
          </span>
          <strong>{t('sql_analysis.explain_hotspot.share', { share: formatShare(share) })}</strong>
        </span>
      )}
      {node.table && (
        <span className="gn-explain-node__field" title={node.table}>
          <span className="gn-explain-node__field-label">{t('sql_analysis.explain_graph.label.table')}</span>
          <code>{node.table}</code>
        </span>
      )}
      {node.index && (
        <span className="gn-explain-node__field" title={node.index}>
          <span className="gn-explain-node__field-label">{t('sql_analysis.explain_graph.label.index')}</span>
          <code>{node.index}</code>
        </span>
      )}
      <NodeMetrics node={node} analyzed={analyzed} />
      {(misestimate || flags.has('HIGH_COST') || flags.has('FULL_SCAN') || flags.has('FILESORT') || flags.has('TEMP_TABLE')) && (
        <span className="gn-explain-node__flags">
          {misestimate && <FlagBadge tone="warning" text={misestimate} />}
          {flags.has('HIGH_COST') && <FlagBadge tone="danger" text={t(analyzed ? 'sql_analysis.explain_graph.flag.time_hotspot' : 'sql_analysis.explain_graph.flag.high_cost')} />}
          {flags.has('FULL_SCAN') && <FlagBadge tone="danger" text={t('sql_analysis.explain_graph.flag.full_scan')} />}
          {flags.has('FILESORT') && <FlagBadge tone="warning" text={t('sql_analysis.explain_graph.flag.filesort')} />}
          {flags.has('TEMP_TABLE') && <FlagBadge tone="info" text={t('sql_analysis.explain_graph.flag.temp_table')} />}
        </span>
      )}
      <Handle type="source" position={horizontal ? Position.Left : Position.Bottom} isConnectable={false} />
    </button>
  )
})
