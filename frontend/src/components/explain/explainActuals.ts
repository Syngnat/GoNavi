import type { I18nParams } from '../../i18n/types'
import { formatMs, type ExplainNode } from '../../utils/explainTypes'

type Translate = (key: string, params?: I18nParams) => string

// 实测计划的展示辅助：实际行数、耗时与估算偏差。后端各方言统一按“每次循环”的平均值给出
// actualRows / durationMs，这里换算成整步合计，并把偏差倍数变成能读的说法。

/**
 * Rows a measured step returned per loop. The backend omits a zero, so a step
 * that ran and carries an estimate reports 0 here; a grouping step without
 * row counts (MariaDB's query block) reports none.
 */
export function explainActualRows(node: ExplainNode, analyzed?: boolean): number | undefined {
  if (typeof node.actualRows === 'number') return node.actualRows
  if (analyzed && (node.loops ?? 0) > 0 && typeof node.estRows === 'number') return 0
  return undefined
}

/** The executor skipped this step (its outer side produced nothing). */
export function explainNeverExecuted(node: ExplainNode): boolean {
  return node.extra?.neverExecuted === true
}

/** Time a step took over all of its loops. */
export function explainNodeTotalMs(node: ExplainNode): number | undefined {
  if (!node.durationMs || node.durationMs <= 0) return undefined
  return node.durationMs * Math.max(1, node.loops ?? 1)
}

export function formatStepMs(ms: number, locale?: string): string {
  return ms > 0 && ms < 0.1 ? '<0.1ms' : formatMs(ms, locale)
}

/** The backend flagged the estimate as far enough off to matter. */
export function isExplainMisestimated(node: ExplainNode): boolean {
  return Boolean(node.estimateFactor) && ((node.flags ?? []) as string[]).includes('UNCERTAIN_ROWS')
}

/** "少估 21 倍" / "多估 3.5 倍" / "基本准确"; null when the step was not compared. */
export function describeExplainEstimate(node: ExplainNode, t: Translate): string | null {
  const factor = node.estimateFactor
  if (!factor || !Number.isFinite(factor) || factor <= 0) return null
  const magnitude = factor >= 1 ? factor : 1 / factor
  if (magnitude < 2) return t('sql_analysis.explain_graph.estimate.accurate')
  const shown = magnitude >= 10 ? Math.round(magnitude) : Math.round(magnitude * 10) / 10
  return t(
    factor > 1 ? 'sql_analysis.explain_graph.flag.under_estimated' : 'sql_analysis.explain_graph.flag.over_estimated',
    { factor: shown },
  )
}
