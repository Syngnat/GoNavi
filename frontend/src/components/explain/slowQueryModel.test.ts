import { describe, expect, it } from 'vitest'
import {
  buildSlowQuerySummary,
  filterSlowQueryRecords,
  getSlowQueryPreview,
  getSlowQuerySql,
  getSlowQueryDiagnosisBlocker,
  getSlowQueryDurationRatio,
  getVisibleSlowQueryRecords,
  isSlowQueryRecordDiagnosable,
  resolveSlowQueryRecency,
  resolveSlowQuerySeverity,
} from './slowQueryModel'

describe('slowQueryModel', () => {
  it('prefers the complete SQL text and keeps legacy preview records loadable', () => {
    expect(getSlowQuerySql({ sqlText: 'select * from orders', sqlPreview: 'select *' })).toEqual({
      sql: 'select * from orders',
      truncated: false,
    })
    expect(getSlowQuerySql({ sqlPreview: 'select 1' })).toEqual({ sql: 'select 1', truncated: false })
    expect(getSlowQuerySql({ sqlPreview: 'select * from a very_long_table…' })).toEqual({
      sql: 'select * from a very_long_table…',
      truncated: true,
    })
    expect(getSlowQuerySql({ sqlPreview: 'select * from a very_long_table...' })).toEqual({
      sql: 'select * from a very_long_table...',
      truncated: true,
    })
    expect(getSlowQuerySql({ sqlText: 'select * fro', sqlTruncated: true })).toEqual({
      sql: 'select * fro',
      truncated: true,
    })
  })

  it('filters records by SQL, database type and fingerprint without mutating their order', () => {
    const records = [
      { id: '1', sqlText: 'SELECT * FROM orders', dbType: 'postgresql', sqlFp: 'fp-orders' },
      { id: '2', sqlPreview: 'SELECT * FROM users', dbType: 'mysql', sqlFp: 'fp-users' },
    ]

    expect(filterSlowQueryRecords(records, '  ORDERS ')).toEqual([records[0]])
    expect(filterSlowQueryRecords(records, 'MYSQL')).toEqual([records[1]])
    expect(filterSlowQueryRecords(records, 'fp-users')).toEqual([records[1]])
    expect(filterSlowQueryRecords(records, '')).toEqual(records)
  })

  it('summarizes aggregated and legacy records consistently', () => {
    expect(buildSlowQuerySummary([
      { executionCount: 3, maxDurationMs: 2400, durationMs: 1800, rowsReturned: 20 },
      { durationMs: 900, maxRowsReturned: 80 },
    ])).toEqual({
      statementCount: 2,
      executionCount: 4,
      maxDurationMs: 2400,
      rowsReturned: 80,
    })
  })

  it('renders the bounded preview by default even when a full SQL text is available', () => {
    const longSql = `SELECT * FROM audit_log WHERE payload = '${'x'.repeat(1000)}'`
    expect(getSlowQueryPreview({ sqlText: longSql, sqlPreview: 'SELECT * FROM audit_log…' })).toBe(
      'SELECT * FROM audit_log…',
    )
    expect(getSlowQueryPreview({ sqlText: longSql }, 120)).toHaveLength(121)
    expect(getSlowQueryPreview({ sqlText: longSql }, 120)).toMatch(/…$/)
  })

  it('limits the initial card count and supports incremental reveal', () => {
    const records = Array.from({ length: 75 }, (_, index) => ({ id: String(index) }))
    expect(getVisibleSlowQueryRecords(records, 30)).toHaveLength(30)
    expect(getVisibleSlowQueryRecords(records, 60)).toHaveLength(60)
    expect(getVisibleSlowQueryRecords(records, 100)).toHaveLength(75)
  })

  it('only loads newly classified single read-only statements for diagnosis', () => {
    expect(isSlowQueryRecordDiagnosable({ sqlText: 'SELECT 1' })).toBe(true)
    expect(isSlowQueryRecordDiagnosable({ sqlText: 'SELECT 1', statementCount: 1, diagnosable: true })).toBe(true)
    expect(isSlowQueryRecordDiagnosable({ sqlText: 'UPDATE users SET active = 1', statementCount: 1, diagnosable: false })).toBe(false)
    expect(isSlowQueryRecordDiagnosable({ sqlText: 'SELECT 1; SELECT 2', statementCount: 2, diagnosable: false })).toBe(false)
  })

  it('classifies severity by duration', () => {
    expect(resolveSlowQuerySeverity(999)).toBe('normal')
    expect(resolveSlowQuerySeverity(1_000)).toBe('warning')
    expect(resolveSlowQuerySeverity(5_000)).toBe('critical')
  })

  it('explains why a record cannot be loaded into diagnosis, most specific reason first', () => {
    expect(getSlowQueryDiagnosisBlocker({ sqlText: 'select 1' }, true)).toBeNull()
    expect(getSlowQueryDiagnosisBlocker({ sqlText: 'select 1', sqlTruncated: true }, false)).toBe('truncated')
    expect(getSlowQueryDiagnosisBlocker({ sqlText: 'select 1' }, false)).toBe('unsupported')
    expect(getSlowQueryDiagnosisBlocker({ sqlText: 'update t set a=1', statementCount: 1, diagnosable: false }, true)).toBe('not_diagnosable')
    expect(getSlowQueryDiagnosisBlocker({ sqlText: 'select 1; select 2', statementCount: 2 }, true)).toBe('not_diagnosable')
  })

  it('buckets relative time and ignores unparsable timestamps', () => {
    const now = Date.parse('2026-09-30T12:00:00Z')
    expect(resolveSlowQueryRecency('2026-09-30T11:59:30Z', now)).toEqual({ kind: 'just_now' })
    expect(resolveSlowQueryRecency('2026-09-30T11:15:00Z', now)).toEqual({ kind: 'minutes', count: 45 })
    expect(resolveSlowQueryRecency('2026-09-30T07:00:00Z', now)).toEqual({ kind: 'hours', count: 5 })
    expect(resolveSlowQueryRecency('2026-09-27T12:00:00Z', now)).toEqual({ kind: 'days', count: 3 })
    expect(resolveSlowQueryRecency('nope', now)).toBeNull()
    expect(resolveSlowQueryRecency(undefined, now)).toBeNull()
  })

  it('keeps the duration ratio within 0..1', () => {
    expect(getSlowQueryDurationRatio(500, 1000)).toBe(0.5)
    expect(getSlowQueryDurationRatio(2000, 1000)).toBe(1)
    expect(getSlowQueryDurationRatio(10, 0)).toBe(0)
  })
})
