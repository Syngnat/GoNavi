import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Empty, Spin } from 'antd'
import { DiagnoseQuery, DiagnoseQueryWithOptions } from '../../../wailsjs/go/app/App'
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig'
import { useI18n } from '../../i18n/provider'
import type { ConnectionConfig } from '../../types'
import type { DiagnoseReport, ExplainNode, IndexSuggestion } from '../../utils/explainTypes'
import ExplainReportBody from './ExplainReportBody'
import type { ExplainBaseline } from './ExplainCompareView'
import './ExplainReport.css'

// SQL 诊断报告：左侧 react-flow 执行计划图（点击节点联动），右侧统计 / 节点详情 / 索引建议；
// 「原文」页签用于对照数据库返回的原始 EXPLAIN 输出。
// 颜色全部取应用主题变量（--gn-*），不再用 antd token 覆盖，自定义主题下才能整页一致。


interface ExplainReportViewProps {
  config: ConnectionConfig
  dbName: string
  sql: string
  runKey?: string | number | null
  /** The run requested by runKey measures the query for real (EXPLAIN ANALYZE). */
  analyze?: boolean
  /** Ask to measure the current SQL; the caller confirms and bumps runKey with analyze set. */
  onAnalyze?: () => void
  /** Before/after comparison, kept by the caller so it outlives this view. */
  baseline?: ExplainBaseline | null
  onPinBaseline?: (report: DiagnoseReport) => void
  onClearBaseline?: () => void
}

export function ExplainReportView({
  config,
  dbName,
  sql,
  runKey,
  analyze = false,
  onAnalyze,
  baseline,
  onPinBaseline,
  onClearBaseline,
}: ExplainReportViewProps) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<DiagnoseReport | null>(null)
  const [reportRevision, setReportRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const hasRequestedRun = runKey !== null && runKey !== undefined && runKey !== ''
  const requestSequenceRef = useRef(0)
  const requestInputRef = useRef({ config, dbName, sql, t, analyze })
  requestInputRef.current = { config, dbName, sql, t, analyze }

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
      const rpcConfig = buildRpcConnectionConfig(currentInput.config)
      const result = currentInput.analyze
        ? await DiagnoseQueryWithOptions(rpcConfig, currentInput.dbName, currentInput.sql, { analyze: true })
        : await DiagnoseQuery(rpcConfig, currentInput.dbName, currentInput.sql)
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
          <Spin tip={t(analyze ? 'sql_analysis.analyze.loading' : 'sql_analysis.explain.loading')} />
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
        <Spin spinning={loading} tip={t(analyze ? 'sql_analysis.analyze.loading' : 'sql_analysis.explain.loading')} wrapperClassName="gn-explain-report-spinner">
          <ExplainReportBody
            report={report}
            reportRevision={reportRevision}
            selectedNodeId={selectedNodeId}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNodeId}
            onSelectSuggestion={handleSelectSuggestion}
            onAnalyze={onAnalyze}
            analyzing={loading && analyze}
            baseline={baseline}
            onPinBaseline={onPinBaseline}
            onClearBaseline={onClearBaseline}
          />
        </Spin>
      ) : null}
    </div>
  )
}
