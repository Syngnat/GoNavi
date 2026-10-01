import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n/provider'
import SlowQueryList from './SlowQueryList'
import SlowQueryPreview from './SlowQueryPreview'
import type { SlowQueryRecord } from './slowQueryModel'

vi.mock('../../store', () => ({
  useStore: (selector: (state: any) => unknown) => selector({ connections: [], addTab: vi.fn() }),
}))

const records: SlowQueryRecord[] = [
  {
    id: 'a',
    sqlFp: 'fp-a',
    dbType: 'postgresql',
    sqlText: 'SELECT *\n\n  FROM orders\n\n WHERE id = $1',
    maxDurationMs: 6200,
    avgDurationMs: 2200,
    executionCount: 9,
    maxRowsRead: 70000,
    maxRowsReturned: 106,
    statementCount: 1,
  },
  {
    id: 'b',
    dbType: 'postgresql',
    sqlText: 'UPDATE orders SET status = $1',
    maxDurationMs: 700,
    executionCount: 2,
    statementCount: 1,
    diagnosable: false,
  },
]

const withI18n = (node: React.ReactElement) => renderToStaticMarkup(
  <I18nProvider preference="zh-CN" systemLanguages={['zh-CN']} onPreferenceChange={vi.fn()}>{node}</I18nProvider>,
)

const renderList = (overrides: Partial<React.ComponentProps<typeof SlowQueryList>> = {}) => withI18n(
  <SlowQueryList
    records={records}
    totalCount={records.length}
    loading={false}
    emptyDescription={null}
    selectedKey="a"
    supportsDiagnosis
    hasMore={false}
    onShowMore={vi.fn()}
    onSelect={vi.fn()}
    onPick={vi.fn()}
    onRestore={vi.fn()}
    onCopy={vi.fn()}
    {...overrides}
  />,
)

describe('SlowQueryList', () => {
  it('shows rank, severity, timing, row counts and a blank-line-free SQL preview per row', () => {
    const markup = renderList()

    expect(markup).toContain('#1')
    expect(markup).toContain('#2')
    expect(markup).toContain('6.20s')
    expect(markup).toContain('gn-sq-duration is-critical')
    expect(markup).toContain('700.0ms')
    expect(markup).toContain('SELECT *\n  FROM orders\n WHERE id = $1')
    expect(markup).toContain('9 次')
    expect(markup).toContain('扫描 70,000')
    expect(markup).toContain('返回 106')
    expect(markup).toContain('postgresql')
  })

  it('marks only the selected row and scales the comparison bar by the slowest query', () => {
    const markup = renderList()

    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(markup).toContain('style="width:100%"')
    expect(markup).toContain('style="width:11%"')
  })

  it('shows the empty description when there is nothing to list', () => {
    const markup = renderList({ records: [], totalCount: 0, emptyDescription: '暂无慢查询记录（阈值 500ms）' })

    expect(markup).toContain('暂无慢查询记录（阈值 500ms）')
    expect(markup).not.toContain('role="listbox"')
  })
})

describe('SlowQueryPreview', () => {
  it('prompts for a selection when no record is chosen', () => {
    const markup = withI18n(<SlowQueryPreview record={null} supportsDiagnosis onCopy={vi.fn()} />)

    expect(markup).toContain('在左侧选择一条慢 SQL')
  })

  it('renders full SQL and metrics, and explains why a write cannot be diagnosed', () => {
    const markup = withI18n(
      <SlowQueryPreview record={records[1]} supportsDiagnosis onPick={vi.fn()} onRestore={vi.fn()} onCopy={vi.fn()} />,
    )

    expect(markup).toContain('UPDATE orders SET status = $1')
    expect(markup).toContain('仅单条只读 SELECT/WITH 可载入诊断')
  })

  it('offers diagnosis for a diagnosable record', () => {
    const markup = withI18n(
      <SlowQueryPreview record={records[0]} supportsDiagnosis onPick={vi.fn()} onRestore={vi.fn()} onCopy={vi.fn()} />,
    )

    expect(markup).toContain('载入诊断')
    expect(markup).toContain('2.20s')
    expect(markup).not.toContain('仅单条只读 SELECT/WITH 可载入诊断')
  })
})
