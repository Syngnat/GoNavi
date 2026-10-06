import type { ExplainNode } from '../../utils/explainTypes'

// 执行计划可读性辅助：热点排序、热度分级、连线粗细、热点路径与“这一步在做什么”的文案键。
// 全部是纯函数，计划图、步骤列表与侧栏共用同一套口径。

export type ExplainHeatLevel = 'hot' | 'warm' | 'mild' | 'none'
export type ExplainLayoutDirection = 'TB' | 'LR'

/** Steps below this share are noise next to the real hotspots. */
const MIN_HOTSPOT_SHARE = 0.05
const EDGE_MIN_WIDTH = 1.5
const EDGE_MAX_WIDTH = 6

/** The steps that carry the most of the plan's work, largest first. */
export function rankExplainHotspots(nodes: ExplainNode[], limit = 3): ExplainNode[] {
  return nodes
    .filter((node) => (node.costShare ?? 0) >= MIN_HOTSPOT_SHARE)
    .sort((left, right) => (right.costShare ?? 0) - (left.costShare ?? 0))
    .slice(0, limit)
}

export function explainHeatLevel(share?: number): ExplainHeatLevel {
  if (!share || share <= 0) return 'none'
  if (share >= 0.4) return 'hot'
  if (share >= 0.15) return 'warm'
  return 'mild'
}

/** Width of the edge carrying `rows` up to the parent, on a log scale against the widest flow. */
export function explainEdgeWidth(rows: number | undefined, maxRows: number): number {
  if (!rows || rows <= 0 || maxRows <= 0) return EDGE_MIN_WIDTH
  const ratio = Math.log10(rows + 1) / Math.log10(maxRows + 1)
  return Number((EDGE_MIN_WIDTH + (EDGE_MAX_WIDTH - EDGE_MIN_WIDTH) * Math.min(1, ratio)).toFixed(2))
}

/** Ids from the hottest step up to the root: the chain whose cost reaches the result. */
export function explainHotPath(nodes: ExplainNode[]): Set<string> {
  const [hottest] = rankExplainHotspots(nodes, 1)
  const path = new Set<string>()
  if (!hottest) return path
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let current: ExplainNode | undefined = hottest
  while (current && !path.has(current.id)) {
    path.add(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
}

export function formatCompactRows(rows: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(rows)
}

export function formatShare(share: number): string {
  const percent = share * 100
  return percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)
}

const KNOWN_OPERATIONS = new Set([
  'SCAN', 'INDEX_SCAN', 'INDEX_ONLY', 'JOIN', 'AGGREGATE', 'SORT', 'LIMIT',
  'FILTER', 'SUBQUERY', 'UNION', 'WINDOW', 'MATERIALIZE',
])
const WRITE_OPERATIONS = new Set(['INSERT', 'UPDATE', 'DELETE'])

const operationSuffix = (opType: string): string => {
  if (KNOWN_OPERATIONS.has(opType)) return opType.toLowerCase()
  return WRITE_OPERATIONS.has(opType) ? 'write' : 'other'
}

/** Short, engine-neutral step name ("全表扫描") shown next to the engine's own operator text. */
export function explainOperationKindKey(opType: string): string {
  return `sql_analysis.explain_op.${operationSuffix(opType)}`
}

/** Plain-language explanation key for a normalized operation type. */
export function explainOperationInsightKey(opType: string): string {
  return `sql_analysis.explain_insight.op.${operationSuffix(opType)}`
}

export interface ExplainStepRow {
  key: string
  node: ExplainNode
  children?: ExplainStepRow[]
}

/** Nest the flat node list by parentId for the step list, keeping plan order. */
export function buildExplainStepRows(nodes: ExplainNode[]): ExplainStepRow[] {
  const rows = new Map<string, ExplainStepRow>(nodes.map((node) => [node.id, { key: node.id, node }]))
  const roots: ExplainStepRow[] = []
  nodes.forEach((node) => {
    const row = rows.get(node.id) as ExplainStepRow
    const parent = node.parentId ? rows.get(node.parentId) : undefined
    if (parent && parent !== row) {
      parent.children = [...(parent.children ?? []), row]
    } else {
      roots.push(row)
    }
  })
  return roots
}
