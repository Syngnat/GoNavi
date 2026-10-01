import { Button, Input, Typography } from 'antd'
import { EditOutlined, PlayCircleOutlined, UpOutlined } from '@ant-design/icons'
import { useI18n } from '../../i18n/provider'
import { buildSqlPreviewText } from '../../utils/sqlPreviewText'

const { Text } = Typography

interface DiagnoseSqlInputProps {
  value: string
  /** 已有诊断报告：允许收起成一行摘要，把纵向空间让给计划图。 */
  hasReport: boolean
  collapsed: boolean
  onChange: (value: string) => void
  onRun: () => void
  onCollapsedChange: (collapsed: boolean) => void
}

const SUMMARY_MAX_CHARS = 240

export default function DiagnoseSqlInput({
  value,
  hasReport,
  collapsed,
  onChange,
  onRun,
  onCollapsedChange,
}: DiagnoseSqlInputProps) {
  const { t } = useI18n()
  const runLabel = t(hasReport ? 'sql_analysis.workbench.action.rerun' : 'sql_analysis.workbench.action.run')

  if (collapsed && hasReport) {
    const summary = buildSqlPreviewText(value, SUMMARY_MAX_CHARS).replace(/\s*\n\s*/g, ' ')
    return (
      <div className="gn-sa-sql is-collapsed">
        <code className="gn-sa-sql-summary" title={value}>{summary}</code>
        <div className="gn-sa-sql-actions">
          <Button size="small" icon={<EditOutlined aria-hidden="true" />} onClick={() => onCollapsedChange(false)}>
            {t('sql_analysis.workbench.editor.edit')}
          </Button>
          <Button type="primary" size="small" icon={<PlayCircleOutlined aria-hidden="true" />} onClick={onRun}>
            {runLabel}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="gn-sa-sql">
      <Input.TextArea
        className="gn-sa-sql-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            onRun()
          }
        }}
        placeholder={t('sql_analysis.workbench.editor.placeholder')}
        aria-label={t('sql_analysis.workbench.editor.aria_label')}
        name="sql-analysis-query"
        autoComplete="off"
        spellCheck={false}
        autoSize={{ minRows: 4, maxRows: 10 }}
      />
      <div className="gn-sa-sql-footer">
        <Text type="secondary" className="gn-sa-sql-hint">{t('sql_analysis.workbench.editor.hint')}</Text>
        <div className="gn-sa-sql-actions">
          {hasReport ? (
            <Button size="small" icon={<UpOutlined aria-hidden="true" />} onClick={() => onCollapsedChange(true)}>
              {t('sql_analysis.workbench.editor.collapse')}
            </Button>
          ) : null}
          <Button type="primary" size="small" icon={<PlayCircleOutlined aria-hidden="true" />} onClick={onRun}>
            {runLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
