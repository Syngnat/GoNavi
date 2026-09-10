import { describe, expect, it } from 'vitest';

import { buildAIReadonlyPreviewSQL } from './aiSqlLimit';

describe('buildAIReadonlyPreviewSQL', () => {
  it('limits Oracle readonly SQL with ROWNUM instead of MySQL LIMIT', () => {
    const sql = buildAIReadonlyPreviewSQL('oracle', 'SELECT 1 FROM DUAL;', 50);

    expect(sql).toBe('SELECT * FROM (SELECT 1 FROM DUAL) WHERE ROWNUM <= 50');
    expect(sql.toLowerCase()).not.toContain('limit');
  });

  it('does not add another limit when Oracle SQL already limits rows', () => {
    expect(buildAIReadonlyPreviewSQL('oracle', 'SELECT * FROM users WHERE ROWNUM <= 10', 50))
      .toBe('SELECT * FROM users WHERE ROWNUM <= 10');
    expect(buildAIReadonlyPreviewSQL('oracle', 'SELECT * FROM users FETCH FIRST 10 ROWS ONLY', 50))
      .toBe('SELECT * FROM users FETCH FIRST 10 ROWS ONLY');
  });

  it('resolves custom Oracle drivers from the driver alias', () => {
    expect(buildAIReadonlyPreviewSQL('custom', 'SELECT 1 FROM DUAL;', 50, 'oracle'))
      .toBe('SELECT * FROM (SELECT 1 FROM DUAL) WHERE ROWNUM <= 50');
  });

  it('treats OceanBase Oracle as Oracle dialect when building readonly preview SQL', () => {
    expect(buildAIReadonlyPreviewSQL('oceanbase', 'SELECT 1 FROM DUAL;', 50, 'oceanbase', { oceanBaseProtocol: 'oracle' }))
      .toBe('SELECT * FROM (SELECT 1 FROM DUAL) WHERE ROWNUM <= 50');
  });

  it('keeps MySQL-family SQL on LIMIT syntax', () => {
    expect(buildAIReadonlyPreviewSQL('mysql', 'SELECT * FROM users', 50))
      .toBe('SELECT * FROM users LIMIT 50 OFFSET 0');
  });

  it('limits SQL Server readonly SQL with TOP syntax', () => {
    expect(buildAIReadonlyPreviewSQL('sqlserver', 'SELECT * FROM users', 50))
      .toBe('SELECT TOP 50 * FROM users');
  });

  it('keeps PostgreSQL-compatible and ClickHouse SQL on LIMIT syntax', () => {
    expect(buildAIReadonlyPreviewSQL('postgres', 'SELECT * FROM users', 50))
      .toBe('SELECT * FROM users LIMIT 50 OFFSET 0');
    expect(buildAIReadonlyPreviewSQL('kingbase', 'SELECT * FROM users', 50))
      .toBe('SELECT * FROM users LIMIT 50 OFFSET 0');
    expect(buildAIReadonlyPreviewSQL('clickhouse', 'SELECT * FROM events', 50))
      .toBe('SELECT * FROM events LIMIT 50 OFFSET 0');
  });

  it('ignores apparent limits inside SQL comments', () => {
    expect(buildAIReadonlyPreviewSQL('postgres', 'SELECT id FROM users /* LIMIT 10 */', 50))
      .toBe('SELECT id FROM users LIMIT 50 OFFSET 0 /* LIMIT 10 */');
    expect(buildAIReadonlyPreviewSQL('postgres', 'SELECT id FROM users --LIMIT 10', 50))
      .toBe('SELECT id FROM users LIMIT 50 OFFSET 0 --LIMIT 10');
  });

  it('adds a limit before an existing OFFSET on grouped SQL', () => {
    const sql = 'SELECT dept_id, COUNT(*) total FROM users GROUP BY dept_id HAVING COUNT(*) > 1 ORDER BY total DESC OFFSET 40';
    expect(buildAIReadonlyPreviewSQL('postgres', sql, 50))
      .toBe('SELECT dept_id, COUNT(*) total FROM users GROUP BY dept_id HAVING COUNT(*) > 1 ORDER BY total DESC LIMIT 50 OFFSET 40');
  });

  it('limits Dameng readonly SQL with native LIMIT syntax', () => {
    expect(buildAIReadonlyPreviewSQL('dameng', 'SELECT 1 FROM DUAL;', 50))
      .toBe('SELECT 1 FROM DUAL LIMIT 50 OFFSET 0');
  });

  it('places the Dameng readonly limit before WITH UR', () => {
    expect(buildAIReadonlyPreviewSQL('dameng', 'SELECT 1 FROM DUAL WITH ur;', 50))
      .toBe('SELECT 1 FROM DUAL LIMIT 50 OFFSET 0 WITH ur');
  });

  it('does not limit non-readonly SQL', () => {
    expect(buildAIReadonlyPreviewSQL('oracle', 'UPDATE users SET name = \'a\';', 50))
      .toBe('UPDATE users SET name = \'a\'');
  });
});
