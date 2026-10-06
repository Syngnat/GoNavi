import { useCallback } from 'react'
import { useI18n } from '../../i18n/provider'
import type { SavedConnection } from '../../types'
import { resolveConnectionEnvironmentType } from '../../utils/connectionEnvironment'
import Modal from '../common/ResizableDraggableModal'

/**
 * Measuring runs the user's query for real, so it is confirmed first; on a
 * production connection the confirm button waits out a countdown.
 */
export function useExplainAnalyzeConfirm(connection: SavedConnection | null) {
  const { t } = useI18n()
  return useCallback((onConfirm: () => void) => {
    const production = resolveConnectionEnvironmentType(connection) === 'production'
    const title = t('sql_analysis.analyze.confirm.title')
    const content = (
      <div className="gn-explain-analyze-confirm">
        <p>{t('sql_analysis.analyze.confirm.content')}</p>
        {production ? <p className="gn-explain-analyze-confirm__production">{t('sql_analysis.analyze.confirm.production')}</p> : null}
      </div>
    )
    if (production) {
      void import('../common/countdownDangerConfirm').then(({ showCountdownDangerConfirm }) => {
        showCountdownDangerConfirm({ title, content, confirmText: t('sql_analysis.analyze.confirm.ok'), onOk: onConfirm })
      })
      return
    }
    Modal.confirm({
      title,
      content,
      okText: t('sql_analysis.analyze.confirm.ok'),
      cancelText: t('common.cancel'),
      onOk: onConfirm,
    })
  }, [connection, t])
}
