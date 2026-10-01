import type { KeyboardEvent } from 'react'
import { Button, Empty, Spin } from 'antd'
import { useI18n } from '../../i18n/provider'
import { getSlowQueryDuration, getSlowQueryKey, type SlowQueryRecord } from './slowQueryModel'
import SlowQueryRow, { getSlowQueryRowDomId, type SlowQueryRowActions } from './SlowQueryRow'

interface SlowQueryListProps extends SlowQueryRowActions {
  records: SlowQueryRecord[]
  totalCount: number
  loading: boolean
  /** 加载完成且没有可显示的记录时的说明文案；有记录或仍在加载时传 null。 */
  emptyDescription: string | null
  selectedKey: string
  supportsDiagnosis: boolean
  hasMore: boolean
  onShowMore: () => void
}

export default function SlowQueryList({
  records,
  totalCount,
  loading,
  emptyDescription,
  selectedKey,
  supportsDiagnosis,
  hasMore,
  onShowMore,
  onSelect,
  onPick,
  onRestore,
  onCopy,
}: SlowQueryListProps) {
  const { t } = useI18n()
  const keyed = records.map((record, index) => ({ record, key: getSlowQueryKey(record, index), rank: index + 1 }))
  const maxDurationMs = records.reduce((max, record) => Math.max(max, getSlowQueryDuration(record)), 0)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (keyed.length === 0) return
    const currentIndex = Math.max(0, keyed.findIndex((item) => item.key === selectedKey))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = keyed[Math.min(keyed.length - 1, Math.max(0, currentIndex + delta))]
      onSelect(next.key)
      document.getElementById(getSlowQueryRowDomId(next.key))?.scrollIntoView({ block: 'nearest' })
    }
  }

  return (
    <section className="gn-sq-list-panel" aria-busy={loading}>
      <Spin spinning={loading} tip={t('sql_analysis.slow_query.loading')} wrapperClassName="gn-sq-list-spin">
        {keyed.length > 0 ? (
          <div
            className="gn-sq-list"
            role="listbox"
            tabIndex={0}
            aria-label={t('sql_analysis.slow_query.list.aria_label')}
            aria-activedescendant={selectedKey ? getSlowQueryRowDomId(selectedKey) : undefined}
            onKeyDown={handleKeyDown}
          >
            {keyed.map(({ record, key, rank }) => (
              <SlowQueryRow
                key={key}
                itemKey={key}
                rank={rank}
                record={record}
                selected={key === selectedKey}
                maxDurationMs={maxDurationMs}
                supportsDiagnosis={supportsDiagnosis}
                onSelect={onSelect}
                onPick={onPick}
                onRestore={onRestore}
                onCopy={onCopy}
              />
            ))}
            {hasMore ? (
              <Button block type="text" className="gn-sq-load-more" onClick={onShowMore}>
                {t('sql_analysis.slow_query.action.load_more', { shown: keyed.length, total: totalCount })}
              </Button>
            ) : null}
          </div>
        ) : emptyDescription ? (
          <Empty className="gn-sq-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />
        ) : null}
      </Spin>
    </section>
  )
}
