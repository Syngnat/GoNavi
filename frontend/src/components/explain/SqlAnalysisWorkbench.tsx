import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Segmented, Typography, message } from 'antd'
import { HistoryOutlined, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useStore } from '../../store'
import type { ConnectionConfig, TabData } from '../../types'
import { useI18n } from '../../i18n/provider'
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities'
import { buildRestoredQueryTab } from '../../utils/sqlAuditTab'
import { useWorkbenchThemeStyle } from '../common/useWorkbenchThemeStyle'
import DiagnoseSqlInput from './DiagnoseSqlInput'
import { ExplainReportView } from './ExplainWorkbench'
import { SlowQueryPanelContent } from './SlowQueryPanel'
import type { SlowQueryRecord } from './slowQueryModel'
import './SqlAnalysisWorkbench.css'

const { Title } = Typography

type SqlAnalysisViewKey = 'diagnose' | 'slow-query'

const resolveRequestedView = (tab: TabData): SqlAnalysisViewKey =>
  tab.sqlAnalysisView === 'slow-query' ? 'slow-query' : 'diagnose'

const normalizeConnectionConfig = (connection: any): ConnectionConfig => ({
  ...connection.config,
  port: Number(connection.config.port),
  password: connection.config.password || '',
  database: connection.config.database || '',
  useSSH: connection.config.useSSH || false,
  ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
})

export default function SqlAnalysisWorkbench({ tab }: { tab: TabData }) {
  const { t } = useI18n()
  const themeStyle = useWorkbenchThemeStyle()
  const connections = useStore((state) => state.connections)
  const addTab = useStore((state) => state.addTab)
  const connection = useMemo(
    () => connections.find((item) => item.id === tab.connectionId) || null,
    [connections, tab.connectionId],
  )
  const connectionConfig = useMemo(
    () => (connection ? normalizeConnectionConfig(connection) : null),
    [connection],
  )
  const supportsDiagnosis = connectionConfig
    ? getDataSourceCapabilities(connectionConfig).supportsExplainDiagnosis
    : false
  const dbName = String(tab.dbName || '').trim()
  const [activeView, setActiveView] = useState<SqlAnalysisViewKey>(() => resolveRequestedView(tab))
  const [sqlDraft, setSqlDraft] = useState(() => String(tab.query || ''))
  const [submittedSql, setSubmittedSql] = useState(() => String(tab.query || ''))
  const [diagnoseRunKey, setDiagnoseRunKey] = useState(0)
  const [editorCollapsed, setEditorCollapsed] = useState(false)

  useEffect(() => {
    const nextView = resolveRequestedView(tab)
    const nextSql = String(tab.query || '')
    setActiveView(nextView)
    setSqlDraft(nextSql)
    if (nextView === 'diagnose' && nextSql.trim()) {
      setSubmittedSql(nextSql)
      setDiagnoseRunKey((previous) => previous + 1)
      setEditorCollapsed(true)
    } else if (nextView === 'slow-query') {
      setSubmittedSql('')
      setDiagnoseRunKey(0)
      setEditorCollapsed(false)
    }
  }, [tab.query, tab.sqlAnalysisRequestKey, tab.sqlAnalysisView])

  useEffect(() => {
    if (!connectionConfig || supportsDiagnosis) return
    setActiveView('slow-query')
    setSubmittedSql('')
    setDiagnoseRunKey(0)
  }, [connectionConfig, supportsDiagnosis])

  const triggerDiagnose = useCallback(() => {
    if (!supportsDiagnosis) {
      message.warning(t('sql_analysis.slow_query.unsupported_diagnosis'))
      return
    }
    if (!sqlDraft.trim()) {
      message.warning(t('sql_analysis.workbench.validation.sql_required'))
      return
    }
    setActiveView('diagnose')
    setSubmittedSql(sqlDraft)
    setDiagnoseRunKey((previous) => previous + 1)
    setEditorCollapsed(true)
  }, [sqlDraft, supportsDiagnosis, t])

  const handlePickSlowQuery = useCallback((sql: string) => {
    const nextSql = String(sql || '')
    if (!nextSql.trim()) return
    setSqlDraft(nextSql)
    setSubmittedSql('')
    setDiagnoseRunKey(0)
    setEditorCollapsed(false)
    setActiveView('diagnose')
  }, [])

  const handleRestoreSlowQuery = useCallback((sql: string, record: SlowQueryRecord) => {
    const text = String(sql || '').trim()
    if (!text) return
    addTab(buildRestoredQueryTab({
      sourceId: record.id || record.sqlFp || 'slow-query',
      connectionId: String(tab.connectionId || '').trim(),
      dbName,
      sql: text,
      title: t('query_history.insert.tab_title'),
    }))
    message.warning(t('query_history.insert.redacted_warning'))
  }, [addTab, dbName, t, tab.connectionId])

  const handleViewChange = useCallback((value: string | number) => {
    const nextView = value as SqlAnalysisViewKey
    if (nextView === 'diagnose' && !supportsDiagnosis) {
      message.warning(t('sql_analysis.slow_query.unsupported_diagnosis'))
      return
    }
    if (nextView === 'diagnose') {
      setSubmittedSql('')
      setDiagnoseRunKey(0)
      setEditorCollapsed(false)
    }
    setActiveView(nextView)
  }, [supportsDiagnosis, t])

  const slowQueryLoadKey = useMemo(
    () =>
      activeView === 'slow-query' && connectionConfig
        ? `${tab.sqlAnalysisRequestKey || 'slow-query'}:${tab.connectionId}:${dbName}`
        : null,
    [activeView, connectionConfig, dbName, tab.connectionId, tab.sqlAnalysisRequestKey],
  )

  if (!connectionConfig) {
    return (
      <div className="gn-sa gn-wb-theme" style={themeStyle}>
        <Alert
          type="warning"
          showIcon
          message={t('sql_analysis.workbench.alert.connection_missing_title')}
          description={t('sql_analysis.workbench.alert.connection_missing_description')}
        />
      </div>
    )
  }

  return (
    <div className="gn-sa gn-wb-theme" style={themeStyle}>
      <header className="gn-sa-header">
        <div className="gn-sa-title-group">
          <span className="gn-sa-title-icon" aria-hidden="true"><ThunderboltOutlined /></span>
          <div className="gn-sa-title-copy">
            <Title level={5}>{t('sql_analysis.workbench.title')}</Title>
            <div className="gn-sa-context">
              <strong>{connection?.name || tab.connectionId}{dbName ? ` / ${dbName}` : ''}</strong>
              {connectionConfig.type ? <span className="gn-sa-chip">{connectionConfig.type}</span> : null}
            </div>
          </div>
        </div>
        <Segmented
          value={activeView}
          onChange={handleViewChange}
          className="gn-sa-view-switcher"
          options={[
            {
              value: 'slow-query',
              label: (
                <span className="gn-sa-view-label">
                  <HistoryOutlined />
                  <span>{t('sql_analysis.workbench.view.slow_query')}</span>
                </span>
              ),
            },
            {
              value: 'diagnose',
              disabled: !supportsDiagnosis,
              label: (
                <span className="gn-sa-view-label">
                  <SearchOutlined />
                  <span>{t('sql_analysis.workbench.view.diagnose')}</span>
                </span>
              ),
            },
          ]}
        />
      </header>

      <div className="gn-sa-body">
        {activeView === 'slow-query' ? (
          <SlowQueryPanelContent
            config={connectionConfig}
            dbName={dbName}
            onPickQuery={handlePickSlowQuery}
            onRestoreQuery={handleRestoreSlowQuery}
            activeToken={slowQueryLoadKey}
          />
        ) : (
          <div className="gn-sa-diagnose">
            <DiagnoseSqlInput
              value={sqlDraft}
              hasReport={diagnoseRunKey > 0}
              collapsed={editorCollapsed}
              onChange={setSqlDraft}
              onRun={triggerDiagnose}
              onCollapsedChange={setEditorCollapsed}
            />
            <div className="gn-sa-report">
              <ExplainReportView
                config={connectionConfig}
                dbName={dbName}
                sql={submittedSql}
                runKey={diagnoseRunKey > 0 ? diagnoseRunKey : null}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
