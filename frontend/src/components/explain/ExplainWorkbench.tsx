import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApartmentOutlined, CodeOutlined } from '@ant-design/icons'
import { Alert, Empty, Segmented, Spin, Typography } from 'antd'
import { DiagnoseQuery } from '../../../wailsjs/go/app/App'
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig'
import { useI18n } from '../../i18n/provider'
import type { ConnectionConfig } from '../../types'
import type { DiagnoseReport, ExplainNode, IndexSuggestion } from '../../utils/explainTypes'
import ExplainGraph from './ExplainGraph'
import ExplainSidebar from './ExplainSidebar'
import './ExplainReport.css'

// SQL 诊断报告：左侧 react-flow 执行计划图（点击节点联动），右侧统计 / 节点详情 / 索引建议；
// 「原文」页签用于对照数据库返回的原始 EXPLAIN 输出。
// 颜色全部取应用主题变量（--gn-*），不再用 antd token 覆盖，自定义主题下才能整页一致。

const { Text } = Typography

interface ExplainReportViewProps {
  config: ConnectionConfig
  dbName: string
  sql: string
  runKey?: string | number | null
}

export function ExplainReportView({ config, dbName, sql, runKey }: ExplainReportViewProps) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<DiagnoseReport | null>(null)
  const [reportRevision, setReportRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'plan' | 'raw'>('plan')
  const hasRequestedRun = runKey !== null && runKey !== undefined && runKey !== ''
  const requestSequenceRef = useRef(0)
  const requestInputRef = useRef({ config, dbName, sql, t })
  requestInputRef.current = { config, dbName, sql, t }

  const runDiagnose = useCallback(async () => {
    const currentInput = requestInputRef.current
    const requestSequence = ++requestSequenceRef.current
    if (!currentInput.sql.trim()) {
      setError(currentInput.t('sql_analysis.explain.error.query_required'))
      return
    }
    setLoading(true)
    setError(null)
    setSelectedNodeId(null)
    try {
      const result = await DiagnoseQuery(
        buildRpcConnectionConfig(currentInput.config),
        currentInput.dbName,
        currentInput.sql,
      )
      if (requestSequence !== requestSequenceRef.current) return
      if (!result.success) {
        setError(result.message || currentInput.t('sql_analysis.explain.error.run_failed'))
      } else {
        setReport(result.data as DiagnoseReport)
        setReportRevision((revision) => revision + 1)
      }
    } catch (cause) {
      if (requestSequence === requestSequenceRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!hasRequestedRun) return
    void runDiagnose()
  }, [hasRequestedRun, runDiagnose, runKey])

  useEffect(() => () => {
    requestSequenceRef.current += 1
  }, [])

  useEffect(() => {
    if (report) setActiveView('plan')
  }, [report])

  const selectedNode = useMemo<ExplainNode | undefined>(() => {
    if (!report || !selectedNodeId) return undefined
    return report.plan.nodes.find((node) => node.id === selectedNodeId)
  }, [report, selectedNodeId])

  const handleSelectSuggestion = useCallback((suggestion: IndexSuggestion) => {
    if (suggestion.affectedNodeId) setSelectedNodeId(suggestion.affectedNodeId)
  }, [])

  return (
    <div className="gn-explain-report-view">
      {loading && !report ? (
        <div className="gn-explain-report-loading">
          <Spin tip={t('sql_analysis.explain.loading')} />
        </div>
      ) : null}
      {/* 失败后的重试入口是上方 SQL 栏的「重新诊断」，这里不再放第二个同义按钮。 */}
      {error ? (
        <Alert
          type="error"
          showIcon
          message={t('sql_analysis.explain.error.title')}
          description={error}
          className="gn-explain-report-alert"
        />
      ) : null}
      {!loading && !error && !report && !hasRequestedRun ? (
        <Empty className="gn-explain-report-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sql_analysis.explain.empty')} />
      ) : null}
      {!error && report ? (
        <Spin spinning={loading} tip={t('sql_analysis.explain.loading')} wrapperClassName="gn-explain-report-spinner">
          <div className="gn-explain-report-shell">
            <div className="gn-explain-report-switcher-row">
              <Segmented
                value={activeView}
                onChange={(value) => setActiveView(value as 'plan' | 'raw')}
                className="gn-explain-report-switcher"
                options={[
                  {
                    value: 'plan',
                    label: (
                      <span className="gn-explain-report-switcher-label">
                        <ApartmentOutlined />
                        <span>{t('sql_analysis.explain.view.plan')}</span>
                      </span>
                    ),
                  },
                  {
                    value: 'raw',
                    label: (
                      <span className="gn-explain-report-switcher-label">
                        <CodeOutlined />
                        <span>{t('sql_analysis.explain.view.raw')}</span>
                      </span>
                    ),
                  },
                ]}
              />
              <Text type="secondary" className="gn-explain-report-switcher-meta">
                {t('sql_analysis.explain.meta.node_count', { count: report.plan.nodes.length })}
                <span className="gn-explain-report-switcher-meta-separator">/</span>
                {report.plan.rawFormat}
              </Text>
            </div>

            <div className="gn-explain-report-content">
              {activeView === 'plan' ? (
                <div className="gn-explain-plan-view">
                  <div className="gn-explain-plan-graph">
                    <ExplainGraph
                      key={reportRevision}
                      nodes={report.plan.nodes}
                      edges={report.plan.edges ?? []}
                      selectedNodeId={selectedNodeId ?? undefined}
                      onSelectNode={setSelectedNodeId}
                    />
                  </div>
                  <div className="gn-explain-plan-sidebar">
                    <ExplainSidebar
                      stats={report.plan.stats}
                      warnings={report.plan.warnings}
                      suggestions={report.suggestions ?? []}
                      selectedNode={selectedNode}
                      onSelectSuggestion={handleSelectSuggestion}
                    />
                  </div>
                </div>
              ) : (
                <pre className="gn-explain-raw">{report.plan.rawPayload || t('sql_analysis.explain.raw.empty')}</pre>
              )}
            </div>
          </div>
        </Spin>
      ) : null}
    </div>
  )
}
