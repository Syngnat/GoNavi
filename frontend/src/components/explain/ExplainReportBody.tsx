import { useEffect, useState } from 'react'
import { ApartmentOutlined, CodeOutlined, DiffOutlined, ExperimentOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { Button, Segmented, Tooltip, Typography } from 'antd'
import { useI18n } from '../../i18n/provider'
import { formatMs, type DiagnoseReport, type ExplainNode, type IndexSuggestion } from '../../utils/explainTypes'
import ExplainCompareView, { ExplainBaselineControl, type ExplainBaseline } from './ExplainCompareView'
import ExplainGraph from './ExplainGraph'
import ExplainHotspotStrip from './ExplainHotspotStrip'
import ExplainSidebar from './ExplainSidebar'
import ExplainStepTable from './ExplainStepTable'
import type { ExplainLayoutDirection } from './explainPlanInsights'

const { Text } = Typography

type ExplainReportViewMode = 'plan' | 'steps' | 'raw' | 'compare'

interface ExplainReportBodyProps {
  report: DiagnoseReport
  reportRevision: number
  selectedNodeId: string | null
  selectedNode?: ExplainNode
  onSelectNode: (nodeId: string | null) => void
  onSelectSuggestion: (suggestion: IndexSuggestion) => void
  /** Run the query for real to compare the plan with what happens; offered when the data source supports it. */
  onAnalyze?: () => void
  analyzing?: boolean
  /** The plan pinned for before/after comparison, and how to pin or drop it. */
  baseline?: ExplainBaseline | null
  onPinBaseline?: (report: DiagnoseReport) => void
  onClearBaseline?: () => void
}

/** "Measured, ran in 12.3ms" for a measured plan, and the button that measures (again). */
function AnalyzeControls({ report, onAnalyze, analyzing }: Pick<ExplainReportBodyProps, 'report' | 'onAnalyze' | 'analyzing'>) {
  const { language, t } = useI18n()
  const analyzed = report.plan.analyzed === true
  return (
    <span className="gn-explain-analyze">
      {analyzed ? (
        <>
          <span className="gn-explain-analyze__badge">{t('sql_analysis.analyze.badge')}</span>
          <Text type="secondary" className="gn-explain-analyze__summary">
            {t('sql_analysis.analyze.summary', { duration: formatMs(report.plan.stats.totalDurationMs, language) })}
          </Text>
        </>
      ) : null}
      {report.analyzeSupported && onAnalyze ? (
        <Tooltip title={t('sql_analysis.analyze.action.hint')}>
          <Button size="small" icon={<ExperimentOutlined aria-hidden="true" />} loading={analyzing} onClick={onAnalyze}>
            {t(analyzed ? 'sql_analysis.analyze.action.rerun' : 'sql_analysis.analyze.action.run')}
          </Button>
        </Tooltip>
      ) : null}
    </span>
  )
}

function ViewLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <span className="gn-explain-report-switcher-label">
      {icon}
      <span>{text}</span>
    </span>
  )
}

/** A loaded report: the view switcher, the hotspot strip, then the graph or step list with the sidebar, or the raw output. */
export default function ExplainReportBody({
  report,
  reportRevision,
  selectedNodeId,
  selectedNode,
  onSelectNode,
  onSelectSuggestion,
  onAnalyze,
  analyzing,
  baseline,
  onPinBaseline,
  onClearBaseline,
}: ExplainReportBodyProps) {
  const { t } = useI18n()
  const [activeView, setActiveView] = useState<ExplainReportViewMode>('plan')
  // The layout is a reading preference, so it survives re-running the diagnosis.
  const [direction, setDirection] = useState<ExplainLayoutDirection>('TB')

  const comparable = Boolean(baseline && baseline.report !== report)
  // A new report after pinning a baseline is what the comparison is for.
  useEffect(() => {
    setActiveView(comparable ? 'compare' : 'plan')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report])
  useEffect(() => {
    if (!comparable && activeView === 'compare') setActiveView('plan')
  }, [activeView, comparable])

  return (
    <div className="gn-explain-report-shell">
      <div className="gn-explain-report-switcher-row">
        <Segmented
          value={activeView}
          onChange={(value) => setActiveView(value as ExplainReportViewMode)}
          className="gn-explain-report-switcher"
          options={[
            { value: 'plan', label: <ViewLabel icon={<ApartmentOutlined />} text={t('sql_analysis.explain.view.plan')} /> },
            { value: 'steps', label: <ViewLabel icon={<UnorderedListOutlined />} text={t('sql_analysis.explain.view.steps')} /> },
            { value: 'raw', label: <ViewLabel icon={<CodeOutlined />} text={t('sql_analysis.explain.view.raw')} /> },
            ...(comparable ? [{ value: 'compare', label: <ViewLabel icon={<DiffOutlined />} text={t('sql_analysis.compare.view')} /> }] : []),
          ]}
        />
        {activeView === 'plan' ? (
          <Segmented
            size="small"
            aria-label={t('sql_analysis.explain.layout.label')}
            value={direction}
            onChange={(value) => setDirection(value as ExplainLayoutDirection)}
            options={[
              { value: 'TB', label: t('sql_analysis.explain.layout.vertical') },
              { value: 'LR', label: t('sql_analysis.explain.layout.horizontal') },
            ]}
          />
        ) : null}
        <AnalyzeControls report={report} onAnalyze={onAnalyze} analyzing={analyzing} />
        <ExplainBaselineControl report={report} baseline={baseline} onPin={onPinBaseline} />
        <Text type="secondary" className="gn-explain-report-switcher-meta">
          {t('sql_analysis.explain.meta.node_count', { count: report.plan.nodes.length })}
          <span className="gn-explain-report-switcher-meta-separator">/</span>
          {report.plan.rawFormat}
        </Text>
      </div>

      {activeView !== 'raw' && activeView !== 'compare' ? (
        <ExplainHotspotStrip
          nodes={report.plan.nodes}
          basis={report.plan.hotspotBasis}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
        />
      ) : null}
      <div className="gn-explain-report-content">
        {activeView === 'compare' && baseline ? (
          <ExplainCompareView
            baseline={baseline}
            report={report}
            onRepin={() => onPinBaseline?.(report)}
            onClear={() => onClearBaseline?.()}
          />
        ) : activeView === 'raw' ? (
          <pre className="gn-explain-raw">{report.plan.rawPayload || t('sql_analysis.explain.raw.empty')}</pre>
        ) : (
          <div className="gn-explain-plan-view">
            <div className="gn-explain-plan-graph">
              {activeView === 'plan' ? (
                <ExplainGraph
                  key={reportRevision}
                  nodes={report.plan.nodes}
                  edges={report.plan.edges ?? []}
                  selectedNodeId={selectedNodeId ?? undefined}
                  onSelectNode={onSelectNode}
                  direction={direction}
                  analyzed={report.plan.analyzed}
                />
              ) : (
                <ExplainStepTable
                  nodes={report.plan.nodes}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={onSelectNode}
                  analyzed={report.plan.analyzed}
                />
              )}
            </div>
            <div className="gn-explain-plan-sidebar">
              <ExplainSidebar
                stats={report.plan.stats}
                warnings={report.plan.warnings}
                suggestions={report.suggestions ?? []}
                selectedNode={selectedNode}
                onSelectSuggestion={onSelectSuggestion}
                analyzed={report.plan.analyzed}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
