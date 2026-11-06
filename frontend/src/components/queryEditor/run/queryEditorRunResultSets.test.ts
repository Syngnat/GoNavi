import { describe, expect, it } from 'vitest';

import { collectQueryEditorRunResultSets } from './queryEditorRunResultSets';

const affected = (statementIndex: number, affectedRows = 0) => ({
  rows: [{ affectedRows }],
  columns: ['affectedRows'],
  statementIndex,
});

const rowsResult = (statementIndex: number) => ({
  rows: [{ stmt: 'SELECT 1', org_cnt: 1 }],
  columns: ['stmt', 'org_cnt'],
  statementIndex,
});

const collect = (data: any[], statements: string[], dbType = 'mysql') => collectQueryEditorRunResultSets({
  res: { data },
  queryOptions: {} as any,
  normalizedDbType: dbType,
  sourceStatements: statements,
  hasConcreteQueryResultSetData: () => true,
  executablePlans: statements.map((sql) => ({ originalSql: sql, executedSql: sql })) as any,
  isAffectedRowsResultSetData: (result?: any) => (
    Array.isArray(result?.columns)
    && result.columns.length === 1
    && result.columns[0] === 'affectedRows'
  ),
  anyLimitApplied: false,
  driver: '',
  currentConnectionId: 'conn-1',
  executionDbName: 'demo',
  executionConnectionParams: undefined,
  paramBindings: undefined,
  quotedPlaceholders: false,
  forceReadOnlyResult: true,
});

describe('collectQueryEditorRunResultSets', () => {
  it('hides the empty affected-rows tab produced by a session command', () => {
    const { nextResultSets } = collect(
      [affected(1), rowsResult(2)],
      ['SET SESSION group_concat_max_len = 16777216', 'SELECT 1'],
    );

    expect(nextResultSets).toHaveLength(1);
    expect(nextResultSets[0].sourceStatementIndex).toBe(2);
  });

  it('keeps affected rows for real DML statements', () => {
    const { nextResultSets } = collect(
      [affected(1, 3), rowsResult(2)],
      ['UPDATE t SET c = 1', 'SELECT 1'],
    );

    expect(nextResultSets).toHaveLength(2);
    expect(nextResultSets[0].columns).toEqual(['affectedRows']);
  });

  it('keeps affected rows for DDL so the structure change stays visible', () => {
    const { nextResultSets } = collect(
      [affected(1), rowsResult(2)],
      ['CREATE TABLE t (id int)', 'SELECT 1'],
    );

    expect(nextResultSets).toHaveLength(2);
  });

  it('returns no tabs for a standalone session command', () => {
    const { nextResultSets } = collect(
      [affected(1)],
      ['SET SESSION group_concat_max_len = 16777216'],
    );

    expect(nextResultSets).toHaveLength(0);
  });
});
