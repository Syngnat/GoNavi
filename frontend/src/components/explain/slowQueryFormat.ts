import { useCallback } from 'react'
import { useI18n } from '../../i18n/provider'
import type { SlowQueryRecency } from './slowQueryModel'

/** 把 resolveSlowQueryRecency 的结果渲染成当前语言的相对时间文案。 */
export function useSlowQueryRecencyLabel(): (recency: SlowQueryRecency) => string {
  const { t } = useI18n()
  return useCallback((recency) => {
    switch (recency.kind) {
      case 'just_now':
        return t('sql_analysis.slow_query.relative.just_now')
      case 'minutes':
        return t('sql_analysis.slow_query.relative.minutes_ago', { count: recency.count })
      case 'hours':
        return t('sql_analysis.slow_query.relative.hours_ago', { count: recency.count })
      default:
        return t('sql_analysis.slow_query.relative.days_ago', { count: recency.count })
    }
  }, [t])
}

export const formatSlowQueryAbsoluteTime = (isoTime: string | undefined, locale: string): string => {
  const timestamp = Date.parse(String(isoTime || ''))
  if (Number.isNaN(timestamp)) return String(isoTime || '')
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(timestamp)
}
