import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { message } from 'antd'
import Modal from '../common/ResizableDraggableModal'
import { ClearSlowQueries, GetSlowQueries } from '../../../wailsjs/go/app/App'
import { useI18n } from '../../i18n/provider'
import { useStore } from '../../store'
import type { ConnectionConfig } from '../../types'
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig'
import { confirmProductionMutation } from '../../utils/productionRiskConfirm'
import {
  buildSlowQuerySummary,
  filterSlowQueryRecords,
  getVisibleSlowQueryRecords,
  type SlowQueryRecord,
  type SlowQuerySummary,
} from './slowQueryModel'

export const SLOW_QUERY_THRESHOLD_MS = 500
export const SLOW_QUERY_FETCH_LIMIT = 500
const INITIAL_VISIBLE_COUNT = 30
const VISIBLE_COUNT_STEP = 30

export type SlowQuerySortBy = 'duration' | 'frequency' | 'rowsReturned' | 'recent'

interface UseSlowQueriesInput {
  config: ConnectionConfig
  dbName: string
  /** 为空时不加载；值变化会触发重新加载（用于标签页激活/请求键变化）。 */
  activeToken?: string | number | null
}

export interface SlowQueriesState {
  records: SlowQueryRecord[]
  filteredRecords: SlowQueryRecord[]
  visibleRecords: SlowQueryRecord[]
  summary: SlowQuerySummary
  loading: boolean
  clearing: boolean
  error: string | null
  sortBy: SlowQuerySortBy
  keyword: string
  hasMore: boolean
  setSortBy: (sortBy: SlowQuerySortBy) => void
  setKeyword: (keyword: string) => void
  reload: () => void
  requestClear: () => void
  showMore: () => void
  dismissError: () => void
}

/** 慢 SQL 历史的数据源：加载、排序、搜索、分页展示、清空。 */
export function useSlowQueries({ config, dbName, activeToken }: UseSlowQueriesInput): SlowQueriesState {
  const { t } = useI18n()
  const connection = useStore((state) => state.connections.find((item) => item.id === config.id) || null)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [records, setRecords] = useState<SlowQueryRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SlowQuerySortBy>('duration')
  const [keyword, setKeyword] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const deferredKeyword = useDeferredValue(keyword)
  const requestSequenceRef = useRef(0)

  const load = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await GetSlowQueries(buildRpcConnectionConfig(config), dbName, sortBy, SLOW_QUERY_FETCH_LIMIT)
      if (requestSequence !== requestSequenceRef.current) return
      if (!result.success) {
        setError(result.message || t('sql_analysis.slow_query.error.load_failed'))
        return
      }
      setRecords((result.data as SlowQueryRecord[]) ?? [])
      setVisibleCount(INITIAL_VISIBLE_COUNT)
    } catch (cause) {
      if (requestSequence === requestSequenceRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false)
    }
  }, [config, dbName, sortBy, t])

  useEffect(() => {
    if (activeToken === null || activeToken === undefined || activeToken === '') return
    void load()
    return () => {
      requestSequenceRef.current += 1
    }
  }, [activeToken, load])

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }, [deferredKeyword])

  const requestClear = useCallback(() => {
    Modal.confirm({
      title: t('sql_analysis.slow_query.clear_confirm.title'),
      content: t('sql_analysis.slow_query.clear_confirm.description'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!await confirmProductionMutation(connection, t('connection.production_risk.action.modify_data'), dbName, t)) return
        setClearing(true)
        try {
          const result = await ClearSlowQueries(buildRpcConnectionConfig(config), dbName)
          if (!result.success) throw new Error(result.message || t('sql_analysis.slow_query.error.clear_failed'))
          requestSequenceRef.current += 1
          setLoading(false)
          setRecords([])
          setError(null)
          message.success(t('sql_analysis.slow_query.message.cleared'))
        } catch (cause) {
          message.error((cause instanceof Error ? cause.message : String(cause)) || t('sql_analysis.slow_query.error.clear_failed'))
          throw cause
        } finally {
          setClearing(false)
        }
      },
    })
  }, [config, connection, dbName, t])

  const filteredRecords = useMemo(() => filterSlowQueryRecords(records, deferredKeyword), [deferredKeyword, records])
  const visibleRecords = useMemo(() => getVisibleSlowQueryRecords(filteredRecords, visibleCount), [filteredRecords, visibleCount])
  const summary = useMemo(() => buildSlowQuerySummary(filteredRecords), [filteredRecords])

  return {
    records,
    filteredRecords,
    visibleRecords,
    summary,
    loading,
    clearing,
    error,
    sortBy,
    keyword,
    hasMore: visibleRecords.length < filteredRecords.length,
    setSortBy,
    setKeyword,
    reload: () => void load(),
    requestClear,
    showMore: () => setVisibleCount((count) => count + VISIBLE_COUNT_STEP),
    dismissError: () => setError(null),
  }
}
