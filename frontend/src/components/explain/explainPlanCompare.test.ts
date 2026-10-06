import { describe, expect, it } from 'vitest'
import type { DiagnoseReport, ExplainNode, ExplainResult } from '../../utils/explainTypes'
import { compareExplainPlans, explainRelativeChange, summarizeExplainPlan } from './explainPlanCompare'

const plan = (nodes: ExplainNode[], extra: Partial<ExplainResult> = {}): DiagnoseReport => ({
  plan: {
    dbType: 'mysql',
    sourceSql: 'SELECT 1',
    nodes,
    stats: { totalCost: 100, hasFullScan: false, hasFilesort: false, hasTempTable: false },
    rawFormat: 'json',
    hotspotBasis: 'cost',
    ...extra,
  },
  suggestions: [],
})

const before = plan([
  { id: 'n1', opType: 'JOIN', opDetail: 'Hash Join', costShare: 0.1 },
  { id: 'n2', parentId: 'n1', opType: 'SCAN', table: 'shop.items', estRows: 50000, costShare: 0.8, flags: ['FULL_SCAN'] },
  { id: 'n3', parentId: 'n1', opType: 'INDEX_SCAN', table: 'customers', index: 'idx_city', estRows: 400, costShare: 0.05 },
  { id: 'n4', parentId: 'n2', opType: 'FILTER', opDetail: "Filter: (amount > 500 and city = 'bj')", costShare: 0.005 },
  { id: 'n5', opType: 'SORT', opDetail: 'Sort', costShare: 0 },
])

const after = plan([
  { id: 'm1', opType: 'JOIN', opDetail: 'Hash Join', costShare: 0.2 },
  { id: 'm2', parentId: 'm1', opType: 'INDEX_SCAN', table: 'items', index: 'idx_amount', estRows: 900, costShare: 0.3 },
  { id: 'm3', parentId: 'm1', opType: 'INDEX_SCAN', table: 'customers', index: 'idx_city', estRows: 400, costShare: 0.5 },
  { id: 'm4', parentId: 'm2', opType: 'FILTER', opDetail: "Filter: (amount > 900 and city = 'sh')", costShare: 0 },
  { id: 'm5', opType: 'LIMIT', opDetail: 'Limit', costShare: 0 },
], { stats: { totalCost: 20, hasFullScan: false, hasFilesort: false, hasTempTable: false } })

const byCurrent = (id: string, comparison: ReturnType<typeof compareExplainPlans>) =>
  comparison.steps.find((step) => step.current?.id === id)

describe('compareExplainPlans', () => {
  it('pairs steps by operation, table and index, then by table when the access path changed', () => {
    const comparison = compareExplainPlans(before, after)
    expect(comparison.basis).toBe('cost')
    expect(comparison.mixed).toBe(false)
    const items = byCurrent('m2', comparison)
    expect(items).toMatchObject({ change: 'accessChanged', baseline: { id: 'n2' } })
    // 0.8 × 100 before, 0.3 × 20 after.
    expect(items?.before).toBeCloseTo(80)
    expect(items?.after).toBeCloseTo(6)
    expect(byCurrent('m3', comparison)).toMatchObject({ baseline: { id: 'n3' }, change: 'slower' })
    expect(byCurrent('m1', comparison)).toMatchObject({ baseline: { id: 'n1' }, change: 'faster' })
    // 0.5 of 100 → 0 is a big ratio over a step too small to matter.
    expect(byCurrent('m4', comparison)?.change).toBe('same')
  })

  it('matches steps whose text only differs in literals, and lists what was added or removed', () => {
    const comparison = compareExplainPlans(before, after)
    expect(byCurrent('m4', comparison)?.baseline?.id).toBe('n4')
    expect(byCurrent('m5', comparison)?.change).toBe('added')
    const removed = comparison.steps.find((step) => step.baseline?.id === 'n5')
    expect(removed?.change).toBe('removed')
    expect(removed?.current).toBeUndefined()
  })

  it('compares measured plans on time and warns when only one was measured', () => {
    const measured = (report: DiagnoseReport, totalMs: number): DiagnoseReport => ({
      ...report,
      plan: { ...report.plan, analyzed: true, hotspotBasis: 'time', stats: { ...report.plan.stats, totalDurationMs: totalMs } },
    })
    const timed = compareExplainPlans(measured(before, 400), measured(after, 10))
    expect(timed.basis).toBe('time')
    expect(timed.before.totalMs).toBe(400)
    expect(byCurrent('m2', timed)?.before).toBeCloseTo(320)

    const mixed = compareExplainPlans(before, measured(after, 10))
    expect(mixed).toMatchObject({ mixed: true, basis: 'rows' })
    expect(byCurrent('m3', mixed)).toMatchObject({ before: 400, after: 400, change: 'same' })
  })
})

describe('summarizeExplainPlan', () => {
  it('counts the figures the summary compares', () => {
    expect(summarizeExplainPlan(before.plan)).toEqual({
      analyzed: false,
      totalMs: undefined,
      totalCost: 100,
      rowsRead: 50400,
      fullScans: 1,
      misestimates: 0,
      steps: 5,
    })
  })
})

describe('explainRelativeChange', () => {
  it('reads lower as better and refuses meaningless ratios', () => {
    expect(explainRelativeChange(100, 38)).toBeCloseTo(-0.62)
    expect(explainRelativeChange(10, 25)).toBeCloseTo(1.5)
    expect(explainRelativeChange(0, 5)).toBeUndefined()
    expect(explainRelativeChange(undefined, 5)).toBeUndefined()
  })
})
