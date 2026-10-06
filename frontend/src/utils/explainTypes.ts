// SQL 诊断工作台前端类型定义。
//
// 本文件镜像后端 internal/connection/explain.go 的数据结构。
// 当 Wails 重新生成 models.ts 后，可逐步迁移到 import { connection } from '../wailsjs/go/models'，
// 但在过渡期保持独立类型便于前端独立开发。

// 节点操作类型（与后端 ExplainOp* 常量对齐）。
export type ExplainOpType =
  | 'SCAN' // 全表扫描
  | 'INDEX_SCAN' // 索引扫描
  | 'INDEX_ONLY' // 覆盖索引
  | 'JOIN'
  | 'AGGREGATE'
  | 'SORT'
  | 'LIMIT'
  | 'FILTER'
  | 'SUBQUERY'
  | 'UNION'
  | 'WINDOW'
  | 'MATERIALIZE'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'OTHER'

// 节点警告标志（用于 UI 高亮 + 规则匹配）。
export type ExplainNodeFlag =
  | 'FULL_SCAN'
  | 'FILESORT'
  | 'TEMP_TABLE'
  | 'NO_INDEX'
  | 'HIGH_COST'
  | 'LOW_BUFFER_HIT'
  | 'UNCERTAIN_ROWS'

// EXPLAIN 原文格式。
export type ExplainFormat = 'json' | 'table' | 'xml' | 'text'

// 建议严重度。
export type IndexSuggestionSeverity = 'critical' | 'warning' | 'info'

export interface ExplainNode {
  id: string
  parentId?: string
  opType: ExplainOpType | string
  opDetail?: string
  table?: string
  index?: string
  estRows?: number
  actualRows?: number
  loops?: number
  cost?: number
  durationMs?: number
  bufferHit?: number
  // 这一步自身（不含子步骤）承担的估算工作量占整份计划的比例 0-1，口径见 ExplainResult.hotspotBasis。
  costShare?: number
  // 实测时实际行数 / 估算行数（每次循环、不足 1 行按 1 行）：大于 1 少估，小于 1 多估。
  estimateFactor?: number
  flags?: ExplainNodeFlag[] | string[]
  extra?: Record<string, unknown>
}

export interface ExplainEdge {
  from: string
  to: string
  label?: string
}

export interface ExplainStats {
  totalCost?: number
  totalDurationMs?: number
  rowsRead?: number
  bufferHitRate?: number
  hasFullScan: boolean
  hasFilesort: boolean
  hasTempTable: boolean
  maxEstRows?: number
}

export interface ExplainResult {
  dbType: string
  sourceSql: string
  nodes: ExplainNode[]
  edges?: ExplainEdge[]
  stats: ExplainStats
  warnings?: string[]
  rawFormat: ExplainFormat | string
  rawPayload?: string
  // costShare 的口径：'cost' 估算成本；'rows' 方言无成本时按访问步骤的估算读取行数；'time' 实测的自身耗时。
  hotspotBasis?: 'cost' | 'rows' | 'time' | string
  // 计划来自实测（真实执行后的耗时与行数）。
  analyzed?: boolean
}

export interface IndexSuggestion {
  severity: IndexSuggestionSeverity | string
  rule: string
  reason: string
  suggestedIndex?: string
  affectedNodeId?: string
  affectedTable?: string
  estRows?: number
}

export interface DiagnoseReport {
  plan: ExplainResult
  suggestions: IndexSuggestion[]
  // 该数据源可以用实测模式再跑一次。
  analyzeSupported?: boolean
}

// severityRank 用于 UI 排序：critical 最前。
export const severityRank: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

// opTypeTheme 按 OpType 返回主题色 token（对应 v2-theme.css 的 CSS 变量）。
// 颜色规则：SCAN 红橙（警告）、JOIN 蓝、AGGREGATE 紫、SORT 黄、其他灰。
export function opTypeColor(opType: string): string {
  switch (opType) {
    case 'SCAN':
      return 'var(--gn-explain-scan, #e8590c)'
    case 'INDEX_SCAN':
      return 'var(--gn-explain-index-scan, #1971c2)'
    case 'INDEX_ONLY':
      return 'var(--gn-explain-index-only, #2f9e44)'
    case 'JOIN':
      return 'var(--gn-explain-join, #1971c2)'
    case 'AGGREGATE':
      return 'var(--gn-explain-aggregate, #6741d9)'
    case 'SORT':
      return 'var(--gn-explain-sort, #f08c00)'
    case 'LIMIT':
      return 'var(--gn-explain-limit, #495057)'
    case 'FILTER':
      return 'var(--gn-explain-filter, #495057)'
    case 'SUBQUERY':
      return 'var(--gn-explain-subquery, #7048e8)'
    case 'MATERIALIZE':
      return 'var(--gn-explain-materialize, #e8590c)'
    default:
      return 'var(--gn-explain-other, #868e96)'
  }
}

// severityColor 用于建议列表的左侧色条。
export function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'var(--gn-explain-critical, #fa5252)'
    case 'warning':
      return 'var(--gn-explain-warning, #f08c00)'
    case 'info':
      return 'var(--gn-explain-info, #1c7ed6)'
    default:
      return 'var(--gn-explain-other, #868e96)'
  }
}

// formatNumber 按当前 UI 语言容错格式化数字。
export function formatNumber(n?: number, locale?: string | string[]): string {
  if (n === undefined || n === null || isNaN(n)) return '-'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(n)
}

// formatPercent 把 0-1 的小数格式化为百分比字符串。
export function formatPercent(ratio?: number, locale?: string | string[]): string {
  if (ratio === undefined || ratio === null || isNaN(ratio)) return '-'
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ratio)
}

// formatMs 把毫秒格式化为人类可读（>1s 显示秒）。
export function formatMs(ms?: number, locale?: string | string[]): string {
  if (ms === undefined || ms === null || isNaN(ms)) return '-'
  if (ms >= 1000) {
    return `${new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(ms / 1000)}s`
  }
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ms)}ms`
}
