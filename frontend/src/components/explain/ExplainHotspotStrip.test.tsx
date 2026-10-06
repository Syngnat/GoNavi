import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ExplainNode } from '../../utils/explainTypes'

vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({
    language: 'en-US',
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}(${Object.values(params).join(',')})` : key),
  }),
}))

vi.mock('antd', () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
}))

import ExplainHotspotStrip from './ExplainHotspotStrip'

const nodes: ExplainNode[] = [
  { id: 'n1', opType: 'JOIN', opDetail: 'Nested Loop', costShare: 0.12 },
  { id: 'n2', parentId: 'n1', opType: 'SCAN', table: 'orders', costShare: 0.81 },
  { id: 'n3', parentId: 'n1', opType: 'INDEX_SCAN', table: 'users', costShare: 0.01 },
]

const render = (props: Partial<React.ComponentProps<typeof ExplainHotspotStrip>>): ReactTestRenderer => {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(<ExplainHotspotStrip nodes={nodes} basis="cost" onSelectNode={vi.fn()} {...props} />)
  })
  return renderer
}

describe('ExplainHotspotStrip', () => {
  it('lists the costliest steps with their share and selects one on click', () => {
    const onSelectNode = vi.fn()
    const renderer = render({ onSelectNode })
    const buttons = renderer.root.findAllByType('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].props.className).toContain('gn-explain-hotspot--hot')
    expect(buttons[0].findByProps({ className: 'gn-explain-hotspot__table' }).children).toEqual(['orders'])
    expect(buttons[0].findByType('strong').children).toEqual(['sql_analysis.explain_hotspot.share(81)'])
    act(() => buttons[0].props.onClick())
    expect(onSelectNode).toHaveBeenCalledWith('n2')
  })

  it('names the basis so a rows-based share is not read as cost', () => {
    const renderer = render({ basis: 'rows' })
    expect(renderer.root.findByProps({ className: 'gn-explain-hotspots__title' }).children)
      .toEqual(['sql_analysis.explain_hotspot.title.rows'])
  })

  it('titles a measured plan by time', () => {
    const renderer = render({ basis: 'time' })
    expect(renderer.root.findByProps({ className: 'gn-explain-hotspots__title' }).children)
      .toEqual(['sql_analysis.explain_hotspot.title.time'])
  })

  it('renders nothing without a basis', () => {
    expect(render({ basis: undefined }).toJSON()).toBeNull()
  })
})
