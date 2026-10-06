import type { DiagnoseReport, ExplainNode, ExplainResult } from '../../utils/explainTypes'

// 执行计划前后对比：把基线计划与当前计划的步骤一一配对，说清哪一步变快、变慢、换了访问方式，
// 哪些步骤新增或消失。纯函数，界面在 ExplainCompareView。

/** What the step figures are compared on: measured time when both plans were measured. */
export type ExplainCompareBasis = 'time' | 'cost' | 'rows'

export type ExplainStepChange = 'faster' | 'slower' | 'same' | 'accessChanged' | 'added' | 'removed'

export interface ExplainPlanSummary {
  analyzed: boolean
  totalMs?: number
  totalCost?: number
  rowsRead?: number
  fullScans: number
  misestimates: number
  steps: number
}

export interface ExplainStepComparison {
  key: string
  baseline?: ExplainNode
  current?: ExplainNode
  change: ExplainStepChange
  before?: number
  after?: number
}

export interface ExplainPlanComparison {
  basis: ExplainCompareBasis
  /** One plan was measured and the other only estimated: figures are not like for like. */
  mixed: boolean
  before: ExplainPlanSummary
  after: ExplainPlanSummary
  steps: ExplainStepComparison[]
}

/** A step must change by this factor either way to count as faster or slower. */
const CHANGE_FACTOR = 1.5
/** Steps below this share of the larger plan's total are noise, however their ratio moved. */
const NOISE_SHARE = 0.01
const NOISE_ROWS = 100

const hasFlag = (node: ExplainNode, flag: string) => ((node.flags ?? []) as string[]).includes(flag)
const isAccessStep = (node: ExplainNode) => ['SCAN', 'INDEX_SCAN', 'INDEX_ONLY'].includes(String(node.opType))

export function summarizeExplainPlan(plan: ExplainResult): ExplainPlanSummary {
  const nodes = plan.nodes ?? []
  const rowsRead = nodes.filter(isAccessStep).reduce((sum, node) => sum + (node.estRows ?? 0), 0)
  return {
    analyzed: plan.analyzed === true,
    totalMs: plan.analyzed ? plan.stats?.totalDurationMs : undefined,
    totalCost: plan.stats?.totalCost || undefined,
    rowsRead: rowsRead || undefined,
    fullScans: nodes.filter((node) => hasFlag(node, 'FULL_SCAN')).length,
    misestimates: nodes.filter((node) => hasFlag(node, 'UNCERTAIN_ROWS')).length,
    steps: nodes.length,
  }
}

const normalizeName = (value?: string) => {
  const name = String(value ?? '').trim().toLowerCase().replace(/["`[\]]/g, '')
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
}

// Step text without the literals a rewrite usually changes ("amount > 500" → "amount > ?").
const normalizeDetail = (value?: string) => String(value ?? '')
  .toLowerCase()
  .replace(/'[^']*'/g, '?')
  .replace(/\b\d+(\.\d+)?\b/g, '?')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 60)

const stepSignature = (node: ExplainNode) => {
  const table = normalizeName(node.table)
  return table
    ? `${node.opType}|${table}|${normalizeName(node.index)}`
    : `${node.opType}|${normalizeDetail(node.opDetail)}`
}

function chooseBasis(baseline: ExplainResult, current: ExplainResult): ExplainCompareBasis {
  if (baseline.hotspotBasis === 'time' && current.hotspotBasis === 'time') return 'time'
  if (baseline.hotspotBasis === 'cost' && current.hotspotBasis === 'cost') return 'cost'
  return 'rows'
}

/** The step's own share of the plan's work, in the basis' unit. */
function stepValue(node: ExplainNode, plan: ExplainResult, basis: ExplainCompareBasis): number | undefined {
  if (basis === 'rows') {
    const rows = plan.analyzed && typeof node.actualRows === 'number' ? node.actualRows * Math.max(1, node.loops ?? 1) : node.estRows
    return typeof rows === 'number' ? rows : undefined
  }
  const total = basis === 'time' ? plan.stats?.totalDurationMs : plan.stats?.totalCost
  if (!total || typeof node.costShare !== 'number') return undefined
  return node.costShare * total
}

function noiseFloor(baseline: ExplainResult, current: ExplainResult, basis: ExplainCompareBasis): number {
  if (basis === 'rows') return NOISE_ROWS
  const total = (plan: ExplainResult) => (basis === 'time' ? plan.stats?.totalDurationMs : plan.stats?.totalCost) ?? 0
  return Math.max(total(baseline), total(current)) * NOISE_SHARE
}

function classify(before: number | undefined, after: number | undefined, floor: number): ExplainStepChange {
  if (before === undefined || after === undefined) return 'same'
  if (Math.max(before, after) < floor) return 'same'
  if (before <= 0 && after <= 0) return 'same'
  if (before <= 0) return 'slower'
  const ratio = after / before
  if (ratio <= 1 / CHANGE_FACTOR) return 'faster'
  if (ratio >= CHANGE_FACTOR) return 'slower'
  return 'same'
}

/**
 * Pair the steps of two plans: first by operation, table and index, then by
 * table alone (the access path changed, say a full scan became an index seek).
 * Whatever is left over was added or removed.
 */
export function compareExplainPlans(baseline: DiagnoseReport, current: DiagnoseReport): ExplainPlanComparison {
  const before = baseline.plan
  const after = current.plan
  const basis = chooseBasis(before, after)
  const floor = noiseFloor(before, after, basis)
  const remaining = [...(before.nodes ?? [])]
  const take = (predicate: (node: ExplainNode) => boolean) => {
    const index = remaining.findIndex(predicate)
    return index < 0 ? undefined : remaining.splice(index, 1)[0]
  }
  const pairs: Array<{ current: ExplainNode; baseline?: ExplainNode }> = (after.nodes ?? []).map((node) => ({
    current: node,
    baseline: take((candidate) => stepSignature(candidate) === stepSignature(node)),
  }))
  pairs.forEach((pair) => {
    const table = normalizeName(pair.current.table)
    if (!pair.baseline && table) {
      pair.baseline = take((candidate) => normalizeName(candidate.table) === table)
    }
  })

  const steps: ExplainStepComparison[] = pairs.map(({ current: node, baseline: previous }) => {
    if (!previous) return { key: `+${node.id}`, current: node, change: 'added', after: stepValue(node, after, basis) }
    const beforeValue = stepValue(previous, before, basis)
    const afterValue = stepValue(node, after, basis)
    const accessChanged = stepSignature(previous) !== stepSignature(node)
    return {
      key: `${previous.id}>${node.id}`,
      baseline: previous,
      current: node,
      change: accessChanged ? 'accessChanged' : classify(beforeValue, afterValue, floor),
      before: beforeValue,
      after: afterValue,
    }
  })
  remaining.forEach((node) => {
    steps.push({ key: `-${node.id}`, baseline: node, change: 'removed', before: stepValue(node, before, basis) })
  })

  return {
    basis,
    mixed: Boolean(before.analyzed) !== Boolean(after.analyzed),
    before: summarizeExplainPlan(before),
    after: summarizeExplainPlan(after),
    steps,
  }
}

/** Relative change of a lower-is-better figure: -0.62 is 62% less. */
export function explainRelativeChange(before?: number, after?: number): number | undefined {
  if (before === undefined || after === undefined || !Number.isFinite(before) || !Number.isFinite(after) || before <= 0) {
    return undefined
  }
  return (after - before) / before
}
