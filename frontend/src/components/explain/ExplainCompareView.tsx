import { useMemo } from 'react'
import { PushpinOutlined } from '@ant-design/icons'
import { Button, Table, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useI18n } from '../../i18n/provider'
import { formatMs, formatNumber, type DiagnoseReport, type ExplainNode } from '../../utils/explainTypes'
import { formatStepMs } from './explainActuals'
import { formatOperationLabel, resolveOperationColor } from './ExplainGraphNode'
import {
  compareExplainPlans,
  explainRelativeChange,
  type ExplainCompareBasis,
  type ExplainPlanSummary,
  type ExplainStepChange,
  type ExplainStepComparison,
} from './explainPlanCompare'
import { explainOperationKindKey } from './explainPlanInsights'
import './ExplainCompare.css'

const { Text } = Typography

export interface ExplainBaseline {
  report: DiagnoseReport
  pinnedAt: number
}

/** Pin the report on screen as the plan later runs are compared with. */
export function ExplainBaselineControl({ report, baseline, onPin }: {
  report: DiagnoseReport
  baseline?: ExplainBaseline | null
  onPin?: (report: DiagnoseReport) => void
}) {
  const { t } = useI18n()
  if (!onPin) return null
  if (baseline?.report === report) {
    return <span className="gn-explain-compare__pinned"><PushpinOutlined aria-hidden="true" /> {t('sql_analysis.compare.pinned_badge')}</span>
  }
  return (
    <Tooltip title={t('sql_analysis.compare.pin_hint')}>
      <Button size="small" icon={<PushpinOutlined aria-hidden="true" />} onClick={() => onPin(report)}>
        {t('sql_analysis.compare.pin')}
      </Button>
    </Tooltip>
  )
}

type Translate = ReturnType<typeof useI18n>['t']

const CHANGE_RANK: Record<ExplainStepChange, number> = { accessChanged: 0, slower: 1, faster: 2, added: 3, removed: 4, same: 5 }
const CHANGE_KEY: Record<ExplainStepChange, string> = {
  faster: 'faster', slower: 'slower', same: 'same', accessChanged: 'access_changed', added: 'added', removed: 'removed',
}

function formatBasisValue(value: number | undefined, basis: ExplainCompareBasis, language: string): string {
  if (value === undefined) return '-'
  if (basis === 'time') return formatStepMs(value, language)
  if (basis === 'cost') return value.toFixed(1)
  return formatNumber(Math.round(value), language)
}

/** "-62%" / "+35%" / "×2.4" for a lower-is-better figure, with its tone. */
function describeDelta(before: number | undefined, after: number | undefined, t: Translate): { text: string; tone: string } {
  const change = explainRelativeChange(before, after)
  if (change === undefined) return { text: '-', tone: 'none' }
  if (Math.abs(change) < 0.05) return { text: t('sql_analysis.compare.delta.same'), tone: 'same' }
  if (change >= 1) return { text: `×${((after as number) / (before as number)).toFixed(1)}`, tone: 'worse' }
  // A drop to almost nothing is not "-100%" unless it really is zero.
  const percent = change > -0.99 || after === 0 ? Math.round(change * 100) : Math.max(-99.9, Math.round(change * 1000) / 10)
  return { text: `${change > 0 ? '+' : ''}${percent}%`, tone: change < 0 ? 'better' : 'worse' }
}

interface SummaryRow {
  key: string
  before?: number
  after?: number
  format: (value?: number) => string
  /** Only meaningful once a plan was measured. */
  measuredOnly?: boolean
}

function SummaryTable({ before, after }: { before: ExplainPlanSummary; after: ExplainPlanSummary }) {
  const { language, t } = useI18n()
  const measured = before.analyzed || after.analyzed
  const count = (value?: number) => formatNumber(value ?? 0, language)
  const allRows: SummaryRow[] = [
    { key: 'total_time', before: before.totalMs, after: after.totalMs, format: (value) => formatMs(value, language), measuredOnly: true },
    { key: 'total_cost', before: before.totalCost, after: after.totalCost, format: (value) => (value === undefined ? '-' : value.toFixed(1)) },
    { key: 'rows_read', before: before.rowsRead, after: after.rowsRead, format: (value) => formatNumber(value, language) },
    { key: 'full_scans', before: before.fullScans, after: after.fullScans, format: count },
    { key: 'misestimates', before: before.misestimates, after: after.misestimates, format: count, measuredOnly: true },
    { key: 'steps', before: before.steps, after: after.steps, format: count },
  ]
  const rows = allRows.filter((row) => measured || !row.measuredOnly)
  return (
    <table className="gn-explain-compare__summary">
      <thead>
        <tr>
          <th>{t('sql_analysis.compare.column.metric')}</th>
          <th>{t('sql_analysis.compare.column.baseline')}</th>
          <th>{t('sql_analysis.compare.column.current')}</th>
          <th>{t('sql_analysis.compare.column.change')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, before: beforeValue, after: afterValue, format }) => {
          const delta = key === 'steps' ? { text: '', tone: 'none' } : describeDelta(beforeValue, afterValue, t)
          return (
            <tr key={key}>
              <td>{t(`sql_analysis.compare.metric.${key}`)}</td>
              <td>{format(beforeValue)}</td>
              <td>{format(afterValue)}</td>
              <td className={`gn-explain-compare__delta is-${delta.tone}`}>{delta.text}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function StepLabel({ node }: { node: ExplainNode }) {
  const { t } = useI18n()
  return (
    <span className="gn-explain-step__op" style={{ color: resolveOperationColor(node.opType) }}>
      {node.opType !== 'OTHER' ? <span className="gn-explain-node__kind">{t(explainOperationKindKey(node.opType))}</span> : null}
      {node.opDetail || formatOperationLabel(node.opType)}
    </span>
  )
}

function stepColumns(basis: ExplainCompareBasis, language: string, t: Translate): ColumnsType<ExplainStepComparison> {
  return [
    {
      title: t('sql_analysis.compare.column.change'),
      key: 'change',
      width: 120,
      render: (_value, step) => (
        <span className={`gn-explain-compare__change is-${step.change}`}>{t(`sql_analysis.compare.change.${CHANGE_KEY[step.change]}`)}</span>
      ),
    },
    {
      title: t('sql_analysis.compare.column.step'),
      key: 'step',
      ellipsis: true,
      render: (_value, step) => (
        <span className="gn-explain-compare__step">
          <StepLabel node={(step.current ?? step.baseline) as ExplainNode} />
          {step.change === 'accessChanged' && step.baseline ? (
            <Text type="secondary" className="gn-explain-compare__was">
              {t('sql_analysis.compare.access_from', { step: step.baseline.opDetail || formatOperationLabel(step.baseline.opType) })}
            </Text>
          ) : null}
        </span>
      ),
    },
    {
      title: t('sql_analysis.compare.column.object'),
      key: 'object',
      width: 150,
      ellipsis: true,
      render: (_value, step) => {
        const node = (step.current ?? step.baseline) as ExplainNode
        return <code className="gn-explain-step__object">{[node.table, node.index].filter(Boolean).join(' · ')}</code>
      },
    },
    {
      title: t('sql_analysis.compare.column.baseline'),
      key: 'before',
      width: 100,
      align: 'right',
      render: (_value, step) => formatBasisValue(step.before, basis, language),
    },
    {
      title: t('sql_analysis.compare.column.current'),
      key: 'after',
      width: 100,
      align: 'right',
      render: (_value, step) => formatBasisValue(step.after, basis, language),
    },
  ]
}

/** Baseline against the current plan: the totals, then every step paired up. */
export default function ExplainCompareView({ baseline, report, onRepin, onClear }: {
  baseline: ExplainBaseline
  report: DiagnoseReport
  onRepin: () => void
  onClear: () => void
}) {
  const { language, t } = useI18n()
  const comparison = useMemo(() => compareExplainPlans(baseline.report, report), [baseline.report, report])
  const steps = useMemo(
    () => comparison.steps
      .map((step, order) => ({ step, order }))
      .sort((left, right) => CHANGE_RANK[left.step.change] - CHANGE_RANK[right.step.change] || left.order - right.order)
      .map(({ step }) => step),
    [comparison.steps],
  )
  const baselineSql = baseline.report.plan.sourceSql?.trim() ?? ''
  const currentSql = report.plan.sourceSql?.trim() ?? ''
  const pinnedAt = new Date(baseline.pinnedAt).toLocaleTimeString(language)
  return (
    <div className="gn-explain-compare">
      <div className="gn-explain-compare__head">
        <Text strong>{t('sql_analysis.compare.title', { time: pinnedAt })}</Text>
        <Text type="secondary">{t(`sql_analysis.compare.basis.${comparison.basis}`)}</Text>
        <span className="gn-explain-compare__actions">
          <Button size="small" onClick={onRepin}>{t('sql_analysis.compare.repin')}</Button>
          <Button size="small" onClick={onClear}>{t('sql_analysis.compare.clear')}</Button>
        </span>
      </div>
      {comparison.mixed ? <Text type="warning" className="gn-explain-compare__note">{t('sql_analysis.compare.mixed')}</Text> : null}
      {baselineSql !== currentSql ? (
        <div className="gn-explain-compare__sql">
          <span>{t('sql_analysis.compare.sql.baseline')}</span>
          <code title={baselineSql}>{baselineSql}</code>
          <span>{t('sql_analysis.compare.sql.current')}</span>
          <code title={currentSql}>{currentSql}</code>
        </div>
      ) : null}
      <SummaryTable before={comparison.before} after={comparison.after} />
      <Table<ExplainStepComparison>
        className="gn-explain-steps gn-explain-compare__steps"
        tableLayout="fixed"
        size="small"
        rowKey="key"
        pagination={false}
        columns={stepColumns(comparison.basis, language, t)}
        dataSource={steps}
      />
    </div>
  )
}
