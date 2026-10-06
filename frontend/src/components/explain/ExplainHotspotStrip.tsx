import { Tooltip } from 'antd'
import { useI18n } from '../../i18n/provider'
import type { ExplainNode } from '../../utils/explainTypes'
import { formatOperationLabel } from './ExplainGraphNode'
import { explainHeatLevel, explainOperationKindKey, formatShare, rankExplainHotspots } from './explainPlanInsights'
import './ExplainPlanInsights.css'

interface ExplainHotspotStripProps {
  nodes: ExplainNode[]
  basis?: string
  selectedNodeId?: string | null
  onSelectNode: (nodeId: string) => void
}

/** "Start here": the few steps that carry most of the plan's work, estimated or measured. */
export default function ExplainHotspotStrip({ nodes, basis, selectedNodeId, onSelectNode }: ExplainHotspotStripProps) {
  const { t } = useI18n()
  const hotspots = rankExplainHotspots(nodes)
  if (hotspots.length === 0 || (basis !== 'cost' && basis !== 'rows' && basis !== 'time')) return null
  return (
    <div className="gn-explain-hotspots" role="group" aria-label={t(`sql_analysis.explain_hotspot.title.${basis}`)}>
      <Tooltip title={t(`sql_analysis.explain_hotspot.hint.${basis}`)}>
        <span className="gn-explain-hotspots__title">{t(`sql_analysis.explain_hotspot.title.${basis}`)}</span>
      </Tooltip>
      {hotspots.map((node, index) => {
        // Engine-neutral names ("全表扫描") read faster than "access_type=all" or "Seq Scan".
        const detail = node.opDetail || formatOperationLabel(node.opType)
        const label = node.opType === 'OTHER' ? detail : t(explainOperationKindKey(node.opType))
        return (
          <button
            key={node.id}
            type="button"
            className={`gn-explain-hotspot gn-explain-hotspot--${explainHeatLevel(node.costShare)}${selectedNodeId === node.id ? ' is-selected' : ''}`}
            aria-pressed={selectedNodeId === node.id}
            onClick={() => onSelectNode(node.id)}
          >
            <span className="gn-explain-hotspot__rank">{index + 1}</span>
            <span className="gn-explain-hotspot__label" title={detail}>{label}</span>
            {node.table ? <code className="gn-explain-hotspot__table">{node.table}</code> : null}
            <strong>{t('sql_analysis.explain_hotspot.share', { share: formatShare(node.costShare ?? 0) })}</strong>
          </button>
        )
      })}
    </div>
  )
}
