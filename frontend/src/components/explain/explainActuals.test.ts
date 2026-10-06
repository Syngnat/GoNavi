import { describe, expect, it } from 'vitest'
import type { ExplainNode } from '../../utils/explainTypes'
import {
  describeExplainEstimate,
  explainActualRows,
  explainNeverExecuted,
  explainNodeTotalMs,
  formatStepMs,
  isExplainMisestimated,
} from './explainActuals'

const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}(${Object.values(params).join(',')})` : key)
const node = (extra: Partial<ExplainNode>): ExplainNode => ({ id: 'n1', opType: 'SCAN', ...extra })

describe('explainActuals', () => {
  it('reads a measured step that returned nothing as zero rows', () => {
    expect(explainActualRows(node({ actualRows: 25 }), true)).toBe(25)
    // The backend omits a zero count: a step that ran returned 0 rows.
    expect(explainActualRows(node({ loops: 3, estRows: 10 }), true)).toBe(0)
    // A grouping step with no row counts of its own stays blank.
    expect(explainActualRows(node({ loops: 1 }), true)).toBeUndefined()
    expect(explainActualRows(node({}), true)).toBeUndefined()
    expect(explainActualRows(node({ loops: 3, estRows: 10 }), false)).toBeUndefined()
  })

  it('adds up the time of every loop', () => {
    expect(explainNodeTotalMs(node({ durationMs: 0.0228, loops: 400 }))).toBeCloseTo(9.12)
    expect(explainNodeTotalMs(node({ durationMs: 2.5 }))).toBe(2.5)
    expect(explainNodeTotalMs(node({}))).toBeUndefined()
    expect(formatStepMs(0.004, 'en-US')).toBe('<0.1ms')
    expect(formatStepMs(9.12, 'en-US')).toBe('9.1ms')
  })

  it('says which way and how far the estimate was off', () => {
    expect(describeExplainEstimate(node({ estimateFactor: 19.09 }), t)).toBe('sql_analysis.explain_graph.flag.under_estimated(19)')
    expect(describeExplainEstimate(node({ estimateFactor: 0.2857 }), t)).toBe('sql_analysis.explain_graph.flag.over_estimated(3.5)')
    expect(describeExplainEstimate(node({ estimateFactor: 1.11 }), t)).toBe('sql_analysis.explain_graph.estimate.accurate')
    expect(describeExplainEstimate(node({}), t)).toBeNull()
  })

  it('trusts the backend on which misses matter and which steps never ran', () => {
    expect(isExplainMisestimated(node({ estimateFactor: 25, flags: ['UNCERTAIN_ROWS'] }))).toBe(true)
    expect(isExplainMisestimated(node({ estimateFactor: 25 }))).toBe(false)
    expect(explainNeverExecuted(node({ extra: { neverExecuted: true } }))).toBe(true)
    expect(explainNeverExecuted(node({}))).toBe(false)
  })
})
