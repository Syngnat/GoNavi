import { Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useMemo } from 'react'
import { useI18n } from '../../i18n/provider'
import { formatNumber, type ExplainNode } from '../../utils/explainTypes'
import { formatOperationLabel, resolveOperationColor } from './ExplainGraphNode'
import { localizeExplainFlag } from './ExplainSidebar'
import {
  describeExplainEstimate,
  explainActualRows,
  explainNeverExecuted,
  explainNodeTotalMs,
  formatStepMs,
  isExplainMisestimated,
} from './explainActuals'
import {
  buildExplainStepRows,
  explainHeatLevel,
  explainOperationKindKey,
  formatCompactRows,
  formatShare,
  type ExplainStepRow,
} from './explainPlanInsights'

interface ExplainStepTableProps {
  nodes: ExplainNode[]
  selectedNodeId?: string | null
  onSelectNode: (nodeId: string) => void
  /** The plan was measured: add the actual rows and time next to the estimate. */
  analyzed?: boolean
}

function measuredColumns(language: string, t: ReturnType<typeof useI18n>['t']): ColumnsType<ExplainStepRow> {
  return [
    {
      title: t('sql_analysis.explain_steps.column.actual_rows'),
      key: 'actualRows',
      width: 110,
      align: 'right',
      render: (_value, { node }) => {
        if (explainNeverExecuted(node)) {
          return <span className="gn-explain-node__never">{t('sql_analysis.explain_graph.metric.never_executed')}</span>
        }
        const rows = explainActualRows(node, true)
        if (rows === undefined) return ''
        const loops = node.loops ?? 0
        const text = `${formatNumber(rows, language)}${loops > 1 ? ` ${t('sql_analysis.explain_graph.metric.loops', { count: formatCompactRows(loops, language) })}` : ''}`
        return isExplainMisestimated(node) ? (
          <span className="gn-explain-node__actual is-misestimated" title={describeExplainEstimate(node, t) ?? undefined}>{text}</span>
        ) : text
      },
    },
    {
      title: t('sql_analysis.explain_steps.column.time'),
      key: 'time',
      width: 80,
      align: 'right',
      render: (_value, { node }) => {
        const totalMs = explainNodeTotalMs(node)
        return totalMs === undefined ? '' : formatStepMs(totalMs, language)
      },
    },
  ]
}

/** The plan as an indented list: easier than the graph for deep or wide plans. */
export default function ExplainStepTable({ nodes, selectedNodeId, onSelectNode, analyzed }: ExplainStepTableProps) {
  const { language, t } = useI18n()
  const rows = useMemo(() => buildExplainStepRows(nodes), [nodes])
  const expandedKeys = useMemo(() => nodes.map((node) => node.id), [nodes])
  const columns: ColumnsType<ExplainStepRow> = [
    {
      title: t('sql_analysis.explain_steps.column.step'),
      key: 'step',
      render: (_value, { node }) => (
        <span
          className="gn-explain-step__op"
          style={{ color: resolveOperationColor(node.opType) }}
          title={(node.flags ?? []).map((flag) => localizeExplainFlag(String(flag), t)).join(', ') || undefined}
        >
          {node.opType !== 'OTHER' ? (
            <span className="gn-explain-node__kind">{t(explainOperationKindKey(node.opType))}</span>
          ) : null}
          {node.opDetail || formatOperationLabel(node.opType)}
        </span>
      ),
    },
    {
      title: t('sql_analysis.explain_steps.column.object'),
      key: 'object',
      width: 150,
      ellipsis: true,
      render: (_value, { node }) => (
        <code className="gn-explain-step__object">{[node.table, node.index].filter(Boolean).join(' · ')}</code>
      ),
    },
    {
      title: t('sql_analysis.explain_steps.column.rows'),
      key: 'rows',
      width: 90,
      align: 'right',
      render: (_value, { node }) => (node.estRows === undefined ? '' : formatNumber(node.estRows, language)),
    },
    ...(analyzed ? measuredColumns(language, t) : []),
    {
      title: t('sql_analysis.explain_steps.column.share'),
      key: 'share',
      width: 130,
      render: (_value, { node }) => (node.costShare ? (
        <span className={`gn-explain-step__share gn-explain-step__share--${explainHeatLevel(node.costShare)}`}>
          <span className="gn-explain-node__share-track">
            <span className="gn-explain-node__share-fill" style={{ width: `${Math.max(2, node.costShare * 100)}%` }} />
          </span>
          {t('sql_analysis.explain_hotspot.share', { share: formatShare(node.costShare) })}
        </span>
      ) : null),
    },
  ]
  return (
    <Table<ExplainStepRow>
      className="gn-explain-steps"
      tableLayout="fixed"
      size="small"
      rowKey="key"
      pagination={false}
      columns={columns}
      // The measured columns would squeeze the step names; scroll instead of wrapping them.
      scroll={analyzed ? { x: 900 } : undefined}
      dataSource={rows}
      expandable={{ defaultExpandedRowKeys: expandedKeys, indentSize: 18 }}
      rowClassName={(row) => (row.key === selectedNodeId ? 'gn-explain-step is-selected' : 'gn-explain-step')}
      onRow={(row) => ({ onClick: () => onSelectNode(row.key) })}
    />
  )
}
