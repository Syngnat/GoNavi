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

  it.each([
    ['upper(name) AS name, customers.*', ['name', 'id', 'name_2'], { name: 'ALICE', id: 1, name_2: 'Alice' }],
    ['customers.*, upper(name) AS name', ['id', 'name', 'name_2'], { id: 1, name: 'Alice', name_2: 'ALICE' }],
    ['upper(name) AS "name", *', ['name', 'id', 'name_2'], { name: 'ALICE', id: 1, name_2: 'Alice' }],
    ['*, upper(name) name', ['id', 'name', 'name_2'], { id: 1, name: 'Alice', name_2: 'ALICE' }],
  ])('does not lend wildcard source metadata to colliding expression labels: %s', async (projection, columns, row) => {
    backend.DBGetColumns.mockResolvedValue({ success: true, data: [
      { name: 'id', type: 'bigint', key: 'PRI', comment: 'customer id' },
      { name: 'name', type: 'varchar', comment: 'customer name' },
    ] });
    const input = createInput(`SELECT ${projection} FROM customers`, false);
    vi.mocked(input.executeSqlEditorMultiQuery).mockResolvedValue({ success: true, message: '', data: [{ columns, rows: [row] }] });
    await runQueryEditorSqlStatements(input);
    const titles = await gridComments(input);
    titles.filter(title => title.columnName !== 'id').forEach(title => {
      expect(title.comment).toBeUndefined();
      expect(title.markup).not.toContain('gn-v2-column-title-comment');
    });
    expect(titles.find(title => title.columnName === 'id')?.comment).toBe('customer id');
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
