import React from 'react';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDataGridMetadata } from '../../useDataGridMetadata';
import DataGridColumnTitle from '../../DataGridColumnTitle';
import { resetTableMetadataRequestCacheForTests } from '../../../utils/tableMetadataRequestCache';
import { runQueryEditorSqlStatements, type RunQueryEditorSqlStatementsInput } from './queryEditorSqlRun';
import { clearQueryResultColumnMetaBackfillCache } from '../queryEditorColumnMetaBackfill';
import { clearLocatorMetaCache } from '../../../utils/queryLocatorMetaCache';
import { findSqlStatementRanges } from '../../../utils/sqlStatementSelection';
import { applyQueryEditorSchemaSearchPath } from '../queryEditorSchemaContext';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';

const backend = vi.hoisted(() => ({ DBGetColumns: vi.fn(), DBGetIndexes: vi.fn(), DBGetForeignKeys: vi.fn(), GenerateQueryID: vi.fn() }));
vi.mock('../../../../wailsjs/go/app/App', () => backend);
vi.mock('../../DataGrid', () => ({ GONAVI_ROW_KEY: '__gonavi_row_key__' }));
vi.mock('antd', () => ({
  message: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

function createInput(sql: string, saved: boolean, readOnly = false) {
  const config = { type: 'kingbase', host: 'mock.invalid', port: 54321, user: 'test', database: 'lab', connectionParams: '' };
  const input: RunQueryEditorSqlStatementsInput = {
    splitSQLStatements: (text, dialect) => findSqlStatementRanges(text, dialect).map(range => range.text),
    normalizedRawSQL: sql, normalizedDbType: 'kingbase', resultSets: [], lastExecutedEditorQueryRef: { current: '' },
    currentQuery: sql, normalizeExecutableStatementList: statements => statements, clearUnpinnedResultSets: vi.fn(() => []),
    tab: { id: saved ? 'saved-query' : 'new-query', title: 'Query', type: 'query', connectionId: 'kingbase',
      query: sql, ...(saved ? { filePath: 'queries/customers.sql', queryMode: 'standard' as const } : {}) },
    config, pendingSqlTransactionRef: { current: null }, connCaps: { forceReadOnlyQueryResult: readOnly } as RunQueryEditorSqlStatementsInput['connCaps'],
    conn: { id: 'kingbase', name: 'Kingbase', config }, metadataGenerationRef: { current: 0 }, currentConnectionId: 'kingbase',
    isQueryEditorMetadataRequestCurrent: () => true, tablesRef: { current: [] }, isActive: true, executionDbName: 'lab',
    isCurrentRun: () => true, executionConfig: applyQueryEditorSchemaSearchPath(config, 'dbms_job'),
    queryOptions: { maxRows: 0, showColumnComment: true } as RunQueryEditorSqlStatementsInput['queryOptions'], driver: 'kingbase',
    containsOraclePlsqlDefinition: () => false, normalizeOracleSqlPlusSlashTerminators: text => text,
    recordExecutionOrigin: vi.fn(), executableSQL: sql, runOptions: undefined, paramsDialogState: { open: false, analysis: null },
    paramsState: { analyzeNow: vi.fn(async () => null), quotedPlaceholders: true } as unknown as RunQueryEditorSqlStatementsInput['paramsState'],
    setLoading: vi.fn(), lastParamsRunScopeRef: { current: 'default' }, runScope: 'default', setParamsDialogState: vi.fn(),
    runState: { queryId: '' }, setQueryId: vi.fn(), setExecutionTimingActive: vi.fn(),
    executeSqlEditorMultiQuery: vi.fn(async () => ({ success: true, message: '', data: [{ columns: ['Customer'], rows: [{ Customer: 'Alice' }] }] })),
    executionConnectionParams: applyQueryEditorSchemaSearchPath(config, 'dbms_job').connectionParams, executionSchemaName: 'dbms_job',
    finishQueryEditorSqlClock: () => 1, queryEditorUnmountedRef: { current: false }, addSqlLog: vi.fn(), currentQueryIdRef: { current: '' },
    clearQueryId: vi.fn(), updateResultPanelVisibility: vi.fn(), setExecutionError: vi.fn(), mutatingStatements: [],
    activatePendingSqlTransaction: vi.fn(), sqlEditorCommitMode: 'manual', sqlEditorAutoCommitDelayMs: 0,
    appendPendingSqlTransactionExecution: vi.fn(), hasConcreteQueryResultSetData: () => true, isAffectedRowsResultSetData: () => false,
    mergeResultSets: (_previous, next) => next, setResultSets: vi.fn(), activateExecutedResult: vi.fn(), runSeq: 1,
  };
  return input;
}

function results(input: RunQueryEditorSqlStatementsInput): QueryEditorResultSet[] {
  return vi.mocked(input.setResultSets).mock.calls.at(-1)?.[0] as QueryEditorResultSet[];
}

async function gridComments(input: RunQueryEditorSqlStatementsInput) {
  const rs = results(input)[0];
  let metadata: ReturnType<typeof useDataGridMetadata> | undefined;
  function GridMetadataHarness() {
    metadata = useDataGridMetadata({ connections: [input.conn], connectionId: rs.executionConnectionId,
      connectionParamsOverride: rs.executionConnectionParams, dbName: rs.metadataDbName ?? rs.executionDbName,
      tableName: rs.metadataTableName ?? rs.tableName, exportScope: 'queryResult', visibleColumnNames: rs.columns,
      loading: false, initialColumnMetaMap: rs.columnMetaMap, initialUniqueKeyGroups: rs.uniqueKeyGroups });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(React.createElement(GridMetadataHarness)); });
  const comments = rs.columns.map(columnName => {
    const columnMeta = metadata?.columnMetaMap[columnName] || metadata?.columnMetaMapByLowerName[columnName.toLowerCase()];
    const markup = renderToStaticMarkup(React.createElement(DataGridColumnTitle, { columnName, columnMeta,
      showColumnComment: true, showColumnType: false, metaFontSize: 11, columnMetaHintColor: '', columnMetaTooltipColor: '', darkMode: false }));
    return { columnName, comment: columnMeta?.comment, markup };
  });
  act(() => renderer?.unmount());
  return comments;
}

describe('Kingbase query comment execution path', () => {
  beforeEach(() => {
    clearLocatorMetaCache(); clearQueryResultColumnMetaBackfillCache(); resetTableMetadataRequestCacheForTests();
    backend.DBGetForeignKeys.mockReset().mockResolvedValue({ success: true, data: [] });
    backend.GenerateQueryID.mockReset().mockResolvedValue('query-1');
    backend.DBGetIndexes.mockReset().mockResolvedValue({ success: true, data: [] });
    backend.DBGetColumns.mockReset().mockImplementation((_cfg: unknown, _db: string, table: string) => Promise.resolve({
      success: true, data: table === 'customers' ? [{ name: 'name', type: 'varchar', comment: 'customer name' }] : [],
    }));
  });

  it.each([false, true])('new/saved=%s tabs retain aliased comments on repeat execution', async saved => {
    const input = createInput('SELECT name AS "Customer" FROM customers', saved);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await runQueryEditorSqlStatements(input);
      expect(backend.DBGetColumns.mock.calls.map(call => call[2])).toEqual(['customers']);
      expect(results(input)[0].columnMetaMap?.Customer?.comment).toBe('customer name');
      expect(results(input)[0].executionConnectionParams).toBe(input.executionConfig.connectionParams);
      expect(results(input)[0].exportSql).toBe(input.currentQuery);
    }
    expect(input.executeSqlEditorMultiQuery).toHaveBeenCalledTimes(2);
    expect(backend.DBGetColumns).toHaveBeenCalledTimes(1);
  });

  it('metadata errors do not block query results and stale runs never publish results', async () => {
    backend.DBGetColumns.mockRejectedValue(new Error('metadata unavailable'));
    const input = createInput('SELECT name AS "Customer" FROM customers', false);
    await runQueryEditorSqlStatements(input);
    expect(results(input)[0].rows[0].Customer).toBe('Alice');
    expect(input.executeSqlEditorMultiQuery).toHaveBeenCalledTimes(1);
    const stale = createInput('SELECT name FROM customers', true);
    stale.isCurrentRun = () => false;
    await runQueryEditorSqlStatements(stale);
    expect(stale.setResultSets).not.toHaveBeenCalled();
    expect(stale.executeSqlEditorMultiQuery).not.toHaveBeenCalled();
  });

  it('qualified driver result labels retain only their known source comments', async () => {
    const input = createInput('SELECT name FROM customers', false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: ['customers.name'], rows: [{ 'customers.name': 'Alice' }] }] });
    await runQueryEditorSqlStatements(input);
    expect(results(input)[0].columnMetaMap?.['customers.name']?.comment).toBe('customer name');
  });

  it.each([
    ['SELECT name FROM customers', 'name'],
    ['SELECT name AS "Customer" FROM customers', 'Customer'],
    ['SELECT name FROM customers', 'customers.name'],
  ])('renders the source comment for %s / %s through Grid titles', async (sql, column) => {
    const input = createInput(sql, true);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: [column], rows: [{ [column]: 'Alice' }] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles[0].comment).toBe('customer name');
    expect(titles[0].markup).toContain('gn-v2-column-title-comment');
    expect(titles[0].markup).toContain('customer name');
  });

  it('preserves partial projection maps without filling an expression from a same-named entity column', async () => {
    const input = createInput('SELECT name AS "Customer", COUNT(*) AS name FROM customers', false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: ['Customer', 'name'], rows: [{ Customer: 'Alice', name: 1 }] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles[0].comment).toBe('customer name');
    expect(titles[0].markup).toContain('gn-v2-column-title-comment');
    expect(titles[1].comment).toBeUndefined();
    expect(titles[1].markup).not.toContain('gn-v2-column-title-comment');
  });

  it('retains the existing Grid metadata retry for an ordinary column when run metadata failed', async () => {
    backend.DBGetColumns.mockRejectedValue(new Error('temporary metadata failure'));
    const input = createInput('SELECT name FROM customers', false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockImplementation(async () => {
      backend.DBGetColumns.mockResolvedValue({ success: true, data: [{ name: 'name', type: 'varchar', comment: 'customer name' }] });
      return { success: true, message: '', data: [{ columns: ['name'], rows: [{ name: 'Alice' }] }] };
    });
    await runQueryEditorSqlStatements(input);
    expect(results(input)[0].columnMetaMap).toBeUndefined();
    const beforeGrid = backend.DBGetColumns.mock.calls.length;
    const titles = await gridComments(input);
    expect(backend.DBGetColumns.mock.calls.length).toBeGreaterThan(beforeGrid);
    expect(titles[0].comment).toBe('customer name');
    expect(titles[0].markup).toContain('gn-v2-column-title-comment');
  });

  it.each([false, true])('new/saved=%s aggregate labels never regain entity comments in Grid', async saved => {
    const input = createInput('SELECT COUNT(*) AS name FROM customers', saved);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: ['name'], rows: [{ name: 1 }] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles[0].comment).toBeUndefined();
    expect(titles[0].markup).not.toContain('gn-v2-column-title-comment');
  });

  it('preserves a hidden primary-key locator without duplicating metadata requests', async () => {
    backend.DBGetColumns.mockResolvedValue({ success: true, data: [
      { name: 'id', type: 'bigint', key: 'PRI', comment: 'customer id' },
      { name: 'name', type: 'varchar', comment: 'customer name' },
    ] });
    const input = createInput('SELECT name AS "Customer" FROM customers', false);
    await runQueryEditorSqlStatements(input);
    const result = results(input)[0];
    expect(result.pkColumns).toEqual(['id']);
    expect(result.editLocator?.readOnly).toBe(false);
    expect(result.editLocator?.hiddenColumns).toHaveLength(1);
    const hidden = result.editLocator?.hiddenColumns?.[0] || '';
    expect(result.editLocator?.valueColumns).toEqual([hidden]);
    const executed = vi.mocked(input.executeSqlEditorMultiQuery).mock.calls[0][2];
    expect(executed).toContain(hidden);
    expect(result.columnMetaMap?.Customer?.comment).toBe('customer name');
    expect(backend.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(backend.DBGetIndexes).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string[], Record<string, unknown>, Record<string, string>]>([
    ['upper(name) AS name, customers.*', ['name', 'id', 'name_2'], { name: 'ALICE', id: 1, name_2: 'Alice' }, {}],
    ['customers.*, upper(name) AS name', ['id', 'name', 'name_2'], { id: 1, name: 'Alice', name_2: 'ALICE' }, { name: 'customer name' }],
    ['upper(name) AS "name", *', ['name', 'id', 'name_2'], { name: 'ALICE', id: 1, name_2: 'Alice' }, {}],
    ['*, upper(name) name', ['id', 'name', 'name_2'], { id: 1, name: 'Alice', name_2: 'ALICE' }, { name: 'customer name' }],
  ])('expressions never borrow a same-named entity comment and the entity column keeps it when it comes first: %s', async (projection, columns, row, expectedComments) => {
    backend.DBGetColumns.mockResolvedValue({ success: true, data: [
      { name: 'id', type: 'bigint', key: 'PRI', comment: 'customer id' },
      { name: 'name', type: 'varchar', comment: 'customer name' },
    ] });
    const input = createInput(`SELECT ${projection} FROM customers`, false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns, rows: [row] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles.find(title => title.columnName === 'id')?.comment).toBe('customer id');
    // 后端把重复标签改成 name_2：裸名永远归属投影里先出现的那一项，表达式不借注释。
    titles.filter(title => title.columnName !== 'id').forEach(title => {
      const expected = expectedComments[title.columnName];
      expect(title.comment).toBe(expected);
      if (expected) expect(title.markup).toContain('gn-v2-column-title-comment');
      else expect(title.markup).not.toContain('gn-v2-column-title-comment');
    });
    expect(backend.DBGetColumns).toHaveBeenCalledTimes(1);
  });

  it('read-only results retain aliased comments without enabling edits', async () => {
    const input = createInput('SELECT name AS "Customer" FROM customers', true, true);
    await runQueryEditorSqlStatements(input);
    expect(results(input)[0].columnMetaMap?.Customer?.comment).toBe('customer name');
    expect(results(input)[0].readOnly).toBe(true);
    expect(results(input)[0].editLocator).toBeUndefined();
  });
});
/**
 * 同一结果集里出现「同名列」时，结果列名与注释必须一一对应：
 * 表达式标签不借注释，实体列按投影顺序取首个同名结果列，引号限定列不能被遮蔽偏移截断。
 */
describe('Kingbase same-name result column mapping', () => {
  beforeEach(() => {
    clearLocatorMetaCache(); clearQueryResultColumnMetaBackfillCache(); resetTableMetadataRequestCacheForTests();
    backend.DBGetForeignKeys.mockReset().mockResolvedValue({ success: true, data: [] });
    backend.DBGetIndexes.mockReset().mockResolvedValue({ success: true, data: [] });
  });

  it('never lets a lower-name fallback lend a comment to a same-named expression label', async () => {
    backend.DBGetColumns.mockResolvedValue({ success: true, data: [{ name: 'name', type: 'varchar', comment: 'customer name' }] });
    const input = createInput('SELECT name AS "Customer", upper(name) AS "customer" FROM customers', false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: ['Customer', 'customer'], rows: [{ Customer: 'Alice', customer: 'ALICE' }] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles[0]).toMatchObject({ columnName: 'Customer', comment: 'customer name' });
    expect(titles[1].columnName).toBe('customer');
    expect(titles[1].comment).toBeUndefined();
    expect(titles[1].markup).not.toContain('gn-v2-column-title-comment');
  });

  it('keeps the first same-named entity column when a later alias reuses the label', async () => {
    backend.DBGetColumns.mockImplementation((_cfg: unknown, _db: string, table: string) => Promise.resolve({
      success: true,
      data: table === 'customers'
        ? [{ name: 'id', type: 'bigint', comment: 'customer id' }, { name: 'name', type: 'varchar', comment: 'customer name' }]
        : [{ name: 'id', type: 'bigint', comment: 'order id' }],
    }));
    const input = createInput('SELECT c.*, o.id AS name FROM customers c JOIN orders o ON c.id=o.id', false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: ['id', 'name', 'name_2'], rows: [{ id: 1, name: 'Alice', name_2: 1 }] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles.find(title => title.columnName === 'id')?.comment).toBe('customer id');
    expect(titles.find(title => title.columnName === 'name')?.comment).toBe('customer name');
    expect(titles.find(title => title.columnName === 'name_2')?.comment).toBeUndefined();
  });

  it('keeps comments when one joined table cannot provide metadata', async () => {
    backend.DBGetColumns.mockImplementation((_cfg: unknown, _db: string, table: string) => (
      String(table).includes('orders')
        ? Promise.resolve({ success: false, message: 'Timed out while loading columns', data: [] })
        : Promise.resolve({ success: true, data: [
          { name: 'id', type: 'bigint', key: 'PRI', comment: 'customer id' },
          { name: 'name', type: 'varchar', comment: 'customer name' },
        ] })
    ));
    const input = createInput('SELECT * FROM customers c JOIN orders o ON c.id=o.id', false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: ['id', 'name', 'id_2'], rows: [{ id: 1, name: 'Alice', id_2: 1 }] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles.find(title => title.columnName === 'id')?.comment).toBe('customer id');
    expect(titles.find(title => title.columnName === 'name')?.comment).toBe('customer name');
  });

  it('keeps the first same-named entity column when a later expression reuses the label', async () => {
    backend.DBGetColumns.mockResolvedValue({ success: true, data: [
      { name: 'id', type: 'bigint', key: 'PRI', comment: 'customer id' },
      { name: 'name', type: 'varchar', comment: 'customer name' },
    ] });
    const input = createInput('SELECT c.*, COALESCE(c.id, 0) AS id FROM customers c', false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: ['id', 'name', 'id_2'], rows: [{ id: 1, name: 'Alice', id_2: 1 }] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles.find(title => title.columnName === 'id')?.comment).toBe('customer id');
    expect(titles.find(title => title.columnName === 'name')?.comment).toBe('customer name');
    expect(titles.find(title => title.columnName === 'id_2')?.comment).toBeUndefined();
  });

  it('resolves a quoted qualified column instead of reporting an authoritative empty projection', async () => {
    backend.DBGetColumns.mockResolvedValue({ success: true, data: [{ name: 'name', type: 'varchar', comment: 'customer name' }] });
    const input = createInput('SELECT "c"."name" FROM customers "c"', false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns: ['name'], rows: [{ name: 'Alice' }] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    expect(titles[0]).toMatchObject({ columnName: 'name', comment: 'customer name' });
  });
});
