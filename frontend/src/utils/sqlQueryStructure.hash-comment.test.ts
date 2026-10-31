import { describe, expect, it } from 'vitest';
import { findTopLevelKeyword, getLeadingKeyword, splitSqlTail } from './sqlQueryStructure';
import { applyQueryAutoLimit } from './queryAutoLimit';
import { maskQueryEditorSqlLiteralsAndComments } from '../components/queryEditor/queryEditorSqlScan';
import { parseSimpleSelectInfo } from '../components/queryEditor/queryEditorSelectRewrite';

// issue 1585：达梦/Oracle 的标识符允许 `#`（如 v$archived_log 的 sequence#），
// 井号注释只是 MySQL 系与 ClickHouse 的词法。扫描器若无条件把 `#` 当行注释，
// 会把字段名之后的整行吞掉，导致限流改写插到错误位置生成非法 SQL。
const DAMENG_HASH_SQL = 'select sequence# SEQ, NAME, first_change# FCHG, next_change# from v$archived_log';

describe('hash line comment dialect gating', () => {
  it('keeps dameng identifiers containing # intact', () => {
    expect(findTopLevelKeyword(DAMENG_HASH_SQL, 'from', 'dameng')).toBeGreaterThan(0);
    expect(getLeadingKeyword(DAMENG_HASH_SQL, 'dameng')).toBe('select');
    const { main, tail } = splitSqlTail(DAMENG_HASH_SQL, 'dameng');
    expect(tail).toBe('');
    expect(main).toContain('from v$archived_log');
  });

  it('keeps oracle identifiers containing # intact', () => {
    expect(findTopLevelKeyword(DAMENG_HASH_SQL, 'from', 'oracle')).toBeGreaterThan(0);
  });

  it('does not corrupt the SQL when applying an auto limit for dameng', () => {
    const result = applyQueryAutoLimit(DAMENG_HASH_SQL, 'dameng', 5000, 'dameng');
    // 原始 FROM 与含 # 的列名必须完整保留，LIMIT 只能追加在 FROM 之后。
    expect(result.sql).toContain('from v$archived_log');
    expect(result.sql).toContain('sequence#');
    expect(result.sql).toContain('first_change#');
    expect(result.sql.indexOf('LIMIT')).toBeGreaterThan(result.sql.indexOf('v$archived_log'));
  });

  it('still treats # as a line comment for mysql-family dialects', () => {
    const mysqlSql = 'select a from t # trailing comment';
    expect(findTopLevelKeyword(mysqlSql, 'from', 'mysql')).toBe(9);
  });

  it('still treats # as a line comment for clickhouse', () => {
    const clickhouseSql = 'select a from t # trailing comment';
    expect(findTopLevelKeyword(clickhouseSql, 'from', 'clickhouse')).toBe(9);
  });

  it('does not mask dameng identifiers containing # in the editor scan', () => {
    const masked = maskQueryEditorSqlLiteralsAndComments(DAMENG_HASH_SQL, 'dameng');
    expect(masked).toContain('from v$archived_log');
    expect(masked).toContain('sequence#');
  });

  it('still masks mysql # comments in the editor scan', () => {
    const masked = maskQueryEditorSqlLiteralsAndComments('select a from t # comment', 'mysql');
    expect(masked).not.toContain('comment');
  });
});

// 边界回归：`#` 也是标识符字符（达梦/Oracle），关键词不能从标识符内部切出来，
// 否则 `ORDER BY col#limit` 会被误判为「已有 LIMIT」，自动行数上限失效。
describe('hash identifier keyword boundaries', () => {
  it('does not match a keyword glued inside a # identifier (dameng)', () => {
    expect(findTopLevelKeyword('SELECT a FROM t ORDER BY col#limit', 'limit', 'dameng')).toBe(-1);
    // 以空格分隔的真实 LIMIT 仍能识别。
    expect(findTopLevelKeyword('SELECT a FROM t ORDER BY seq# limit 10', 'limit', 'dameng'))
      .toBeGreaterThan(0);
  });

  it('applies the auto row limit when a # identifier ends with the word limit', () => {
    const sql = 'SELECT a FROM t ORDER BY col#limit';
    const result = applyQueryAutoLimit(sql, 'dameng', 5000, 'dameng');
    expect(result.applied).toBe(true);
    expect(result.sql).toContain('col#limit');
    expect(result.sql.indexOf('LIMIT')).toBeGreaterThan(result.sql.indexOf('from t'));
  });

  it('builds the writable column mapping for # identifiers (dameng)', () => {
    const info = parseSimpleSelectInfo('select sequence# SEQ, NAME from v$archived_log', 'dameng');
    expect(info).toBeTruthy();
    expect(info!.selectsAll).toBe(false);
    expect(info!.writableColumns).toMatchObject({ SEQ: 'sequence#' });
  });

  // 反向边界：# 是注释的方言里，词必须在井号处断开——
  // 否则 LIMIT#注释 后的 LIMIT 漏识别、SELECT#注释 的 leading keyword 变成 select#。
  it('recognizes LIMIT followed by a mysql # comment without appending a second LIMIT', () => {
    const sql = 'SELECT a FROM t LIMIT# picks first 10\n10';
    expect(findTopLevelKeyword(sql, 'limit', 'mysql')).toBeGreaterThan(0);
    const result = applyQueryAutoLimit(sql, 'mysql', 5000, 'mysql');
    expect(result.applied).toBe(false);
    expect(result.sql.match(/limit/gi) || []).toHaveLength(1);
  });

  it('recognizes LIMIT followed by a clickhouse # comment', () => {
    const sql = 'SELECT a FROM t LIMIT# picks first 10\n10';
    expect(findTopLevelKeyword(sql, 'limit', 'clickhouse')).toBeGreaterThan(0);
  });

  it('keeps the leading keyword intact when a mysql # comment follows SELECT', () => {
    const sql = 'SELECT# trailing note\n a FROM t';
    expect(getLeadingKeyword(sql, 'mysql')).toBe('select');
    const result = applyQueryAutoLimit(sql, 'mysql', 5000, 'mysql');
    expect(result.applied).toBe(true);
  });

  it('keeps the leading keyword intact when a clickhouse # comment follows SELECT', () => {
    expect(getLeadingKeyword('SELECT# note\n a FROM t', 'clickhouse')).toBe('select');
  });
});
