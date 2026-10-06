import { describe, expect, it } from 'vitest'
import type { Edge } from 'reactflow'
import type { ExplainNode } from '../../utils/explainTypes'
import { decorateExplainEdges, layoutWithDagre } from './ExplainGraph'
import {
  buildExplainStepRows,
  explainEdgeWidth,
  explainHeatLevel,
  explainHotPath,
  explainOperationInsightKey,
  explainOperationKindKey,
  formatShare,
  rankExplainHotspots,
} from './explainPlanInsights'

// Hash Join over a full scan of orders (70%) and a hashed index scan of users.
const plan: ExplainNode[] = [
  { id: 'n1', opType: 'JOIN', opDetail: 'Hash Join', estRows: 120, costShare: 0.1 },
  { id: 'n2', parentId: 'n1', opType: 'SCAN', table: 'orders', estRows: 50_000, costShare: 0.7, flags: ['FULL_SCAN', 'HIGH_COST'] },
  { id: 'n3', parentId: 'n1', opType: 'OTHER', opDetail: 'Hash', estRows: 200, costShare: 0.02 },
  { id: 'n4', parentId: 'n3', opType: 'INDEX_SCAN', table: 'users', estRows: 200, costShare: 0.18 },
]

describe('explain plan insights', () => {
  it('ranks hotspots and ignores negligible steps', () => {
    expect(rankExplainHotspots(plan).map((node) => node.id)).toEqual(['n2', 'n4', 'n1'])
    expect(rankExplainHotspots(plan, 1).map((node) => node.id)).toEqual(['n2'])
  })

  it('grades heat by share', () => {
    expect([0.7, 0.18, 0.1, 0, undefined].map(explainHeatLevel)).toEqual(['hot', 'warm', 'mild', 'none', 'none'])
    expect(formatShare(0.7)).toBe('70')
    expect(formatShare(0.018)).toBe('1.8')
  })

  it('traces the hot path from the costliest step to the result', () => {
    expect([...explainHotPath(plan)]).toEqual(['n2', 'n1'])
    expect(explainHotPath([{ id: 'x', opType: 'OTHER' }]).size).toBe(0)
  })

  it('widens edges on a log scale of the rows they carry', () => {
    expect(explainEdgeWidth(undefined, 1000)).toBe(1.5)
    expect(explainEdgeWidth(1000, 1000)).toBe(6)
    const small = explainEdgeWidth(10, 1000)
    expect(small).toBeGreaterThan(1.5)
    expect(small).toBeLessThan(4)
  })

  it('explains every operation type in plain words', () => {
    expect(explainOperationInsightKey('SCAN')).toBe('sql_analysis.explain_insight.op.scan')
    expect(explainOperationInsightKey('INDEX_ONLY')).toBe('sql_analysis.explain_insight.op.index_only')
    expect(explainOperationInsightKey('UPDATE')).toBe('sql_analysis.explain_insight.op.write')
    expect(explainOperationInsightKey('SOMETHING_NEW')).toBe('sql_analysis.explain_insight.op.other')
    expect(explainOperationKindKey('SCAN')).toBe('sql_analysis.explain_op.scan')
    expect(explainOperationKindKey('DELETE')).toBe('sql_analysis.explain_op.write')
  })

  it('nests steps by parent for the step list', () => {
    const rows = buildExplainStepRows(plan)
    expect(rows.map((row) => row.key)).toEqual(['n1'])
    expect(rows[0].children?.map((row) => row.key)).toEqual(['n2', 'n3'])
    expect(rows[0].children?.[1].children?.map((row) => row.key)).toEqual(['n4'])
  })
})

describe('explain graph edges', () => {
  const edges = [
    { from: 'n1', to: 'n2' },
    { from: 'n1', to: 'n3', label: 'INNER' },
    { from: 'n3', to: 'n4' },
  ]

  it('labels each edge with the rows flowing up and highlights the hot path', () => {
    const { rfEdges } = layoutWithDagre(plan, edges)
    const decorated = decorateExplainEdges(rfEdges, plan, explainHotPath(plan), (rows) => `~${rows}`)
    const byTarget = new Map(decorated.map((edge: Edge) => [edge.target, edge]))
    expect(byTarget.get('n2')?.label).toBe('~50000')
    expect(byTarget.get('n3')?.label).toBe('INNER · ~200')
    expect(byTarget.get('n2')?.className).toContain('gn-explain-edge--hot')
    expect(byTarget.get('n4')?.className).not.toContain('gn-explain-edge--hot')
    expect(Number(byTarget.get('n2')?.style?.strokeWidth)).toBeGreaterThan(Number(byTarget.get('n4')?.style?.strokeWidth))
  })

  it('labels a nested-loop inner side with the rows it hands up, not the rows per lookup', () => {
    const nestedLoop: ExplainNode[] = [
      { id: 'n1', opType: 'JOIN' },
      { id: 'n2', parentId: 'n1', opType: 'INDEX_SCAN', estRows: 1, extra: { rowsProduced: 600 } },
    ]
    const { rfEdges } = layoutWithDagre(nestedLoop, [{ from: 'n1', to: 'n2' }])
    const [edge] = decorateExplainEdges(rfEdges, nestedLoop, new Set(), (rows) => `~${rows}`)
    expect(edge.label).toBe('~600')
  })

  it('lays the plan out left to right with the result on the right', () => {
    const { rfNodes } = layoutWithDagre(plan, edges, 'LR')
    const x = (id: string) => rfNodes.find((node) => node.id === id)?.position.x ?? 0
    expect(x('n2')).toBeLessThan(x('n1'))
    expect(x('n4')).toBeLessThan(x('n3'))
  })
})
