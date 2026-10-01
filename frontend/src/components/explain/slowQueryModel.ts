export interface SlowQueryRecord {
  id?: string
  connectionFp?: string
  sqlFp?: string
  sqlText?: string
  sqlPreview?: string
  sqlTruncated?: boolean
  diagnosable?: boolean
  statementCount?: number
  dbType?: string
  durationMs?: number
  maxDurationMs?: number
  avgDurationMs?: number
  executionCount?: number
  rowsRead?: number
  maxRowsRead?: number
  rowsReturned?: number
  maxRowsReturned?: number
  planHash?: string
  executedAt?: string
}

export interface SlowQuerySummary {
  statementCount: number
  executionCount: number
  maxDurationMs: number
  rowsReturned: number
}

export function getSlowQuerySql(record: SlowQueryRecord): { sql: string; truncated: boolean } {
  const fullSql = String(record.sqlText || '').trim()
  const preview = String(record.sqlPreview || '').trim()
  const legacyPreviewLooksTruncated = record.sqlTruncated === undefined
    && !fullSql
    && /(?:…|\.\.\.)\s*$/.test(preview)
  return {
    sql: fullSql || preview,
    truncated: record.sqlTruncated === true || legacyPreviewLooksTruncated,
  }
}

export function getSlowQueryPreview(record: SlowQueryRecord, maxLength = 600): string {
  const { sql } = getSlowQuerySql(record)
  const preview = String(record.sqlPreview || '').trim() || sql
  if (preview.length <= maxLength) return preview
  return `${preview.slice(0, maxLength)}…`
}

export function isSlowQueryRecordDiagnosable(record: SlowQueryRecord): boolean {
  const statementCount = Number(record.statementCount) || 0
  if (statementCount <= 0) return true
  return statementCount === 1 && record.diagnosable !== false
}

export function filterSlowQueryRecords(
  records: SlowQueryRecord[],
  keyword: string,
): SlowQueryRecord[] {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase()
  if (!normalizedKeyword) return records

  return records.filter((record) => {
    const { sql } = getSlowQuerySql(record)
    return [sql, record.dbType, record.sqlFp]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(normalizedKeyword))
  })
}

export function buildSlowQuerySummary(records: SlowQueryRecord[]): SlowQuerySummary {
  return records.reduce<SlowQuerySummary>((summary, record) => ({
    statementCount: summary.statementCount + 1,
    executionCount: summary.executionCount + Math.max(1, Number(record.executionCount) || 0),
    maxDurationMs: Math.max(
      summary.maxDurationMs,
      Number(record.maxDurationMs) || Number(record.durationMs) || 0,
    ),
    rowsReturned: Math.max(
      summary.rowsReturned,
      Number(record.maxRowsReturned) || Number(record.rowsReturned) || 0,
    ),
  }), {
    statementCount: 0,
    executionCount: 0,
    maxDurationMs: 0,
    rowsReturned: 0,
  })
}

export function getVisibleSlowQueryRecords(
  records: SlowQueryRecord[],
  visibleCount: number,
): SlowQueryRecord[] {
  return records.slice(0, Math.max(0, visibleCount))
}

export type SlowQuerySeverity = 'normal' | 'warning' | 'critical'
export type SlowQueryDiagnosisBlocker = 'truncated' | 'unsupported' | 'not_diagnosable'
export type SlowQueryRecency =
  | { kind: 'just_now' }
  | { kind: 'minutes' | 'hours' | 'days'; count: number }

const SEVERITY_WARNING_MS = 1_000
const SEVERITY_CRITICAL_MS = 5_000

export function getSlowQueryDuration(record: SlowQueryRecord): number {
  return record.maxDurationMs ?? record.durationMs ?? 0
}

export function getSlowQueryRowsRead(record: SlowQueryRecord): number {
  return record.maxRowsRead ?? record.rowsRead ?? 0
}

export function getSlowQueryRowsReturned(record: SlowQueryRecord): number {
  return record.maxRowsReturned ?? record.rowsReturned ?? 0
}

export function getSlowQueryExecutionCount(record: SlowQueryRecord): number {
  return Math.max(1, Number(record.executionCount) || 0)
}

export function resolveSlowQuerySeverity(durationMs: number): SlowQuerySeverity {
  if (durationMs >= SEVERITY_CRITICAL_MS) return 'critical'
  if (durationMs >= SEVERITY_WARNING_MS) return 'warning'
  return 'normal'
}

/** 为什么这条记录不能直接载入诊断；null 表示可以。截断优先于数据源能力，再到语句类型。 */
export function getSlowQueryDiagnosisBlocker(
  record: SlowQueryRecord,
  supportsDiagnosis: boolean,
): SlowQueryDiagnosisBlocker | null {
  if (getSlowQuerySql(record).truncated) return 'truncated'
  if (!supportsDiagnosis) return 'unsupported'
  if (!isSlowQueryRecordDiagnosable(record)) return 'not_diagnosable'
  return null
}

/** 相对当前时间的粗粒度描述；文案由界面层按语言渲染。无法解析的时间返回 null。 */
export function resolveSlowQueryRecency(isoTime: string | undefined, now = Date.now()): SlowQueryRecency | null {
  const timestamp = Date.parse(String(isoTime || ''))
  if (Number.isNaN(timestamp)) return null
  const diffMs = Math.max(0, now - timestamp)
  if (diffMs < 60_000) return { kind: 'just_now' }
  if (diffMs < 3_600_000) return { kind: 'minutes', count: Math.floor(diffMs / 60_000) }
  if (diffMs < 86_400_000) return { kind: 'hours', count: Math.floor(diffMs / 3_600_000) }
  return { kind: 'days', count: Math.floor(diffMs / 86_400_000) }
}

/** 耗时占当前列表最长耗时的比例（0~1），用于行内对比条。 */
export function getSlowQueryDurationRatio(durationMs: number, maxDurationMs: number): number {
  if (maxDurationMs <= 0) return 0
  return Math.min(1, Math.max(0, durationMs / maxDurationMs))
}

export function getSlowQueryKey(record: SlowQueryRecord, index: number): string {
  return record.id ?? `${record.sqlFp ?? 'slow-query'}:${index}`
}
