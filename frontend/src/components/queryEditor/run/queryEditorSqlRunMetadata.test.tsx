import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { useDataGridMetadata } from '../../useDataGridMetadata';
import { resetTableMetadataRequestCacheForTests } from '../../../utils/tableMetadataRequestCache';
import { clearLocatorMetaCache } from '../../../utils/queryLocatorMetaCache';
import { clearQueryResultColumnMetaBackfillCache } from '../queryEditorColumnMetaBackfill';
import { resolveQueryLocatorPlan } from '../queryEditorLocatorPlan';
import { backfillQueryEditorStatementPlans } from './queryEditorSqlRunMetadata';

const backend = vi.hoisted(() => ({ DBGetColumns: vi.fn(), DBGetIndexes: vi.fn(), DBGetForeignKeys: vi.fn() }));
vi.mock('../../../../wailsjs/go/app/App', () => backend);
vi.mock('../../DataGridCore', () => ({ GONAVI_ROW_KEY: '__gonavi_row_key__' }));

beforeEach(() => {
  clearLocatorMetaCache();
  clearQueryResultColumnMetaBackfillCache();
  resetTableMetadataRequestCacheForTests();
  backend.DBGetColumns.mockReset().mockResolvedValue({ success: true, data: [{ name: 'status', type: 'int', comment: 'customer status' }] });
  backend.DBGetIndexes.mockReset().mockResolvedValue({ success: true, data: [] });
  backend.DBGetForeignKeys.mockReset().mockResolvedValue({ success: true, data: [] });
});

it.each([
  ['COUNT(*)', true], ['COUNT(*)', false], ['NULL', true], ['TRUE', true], ['CURRENT_DATE', true],
] as const)('single-table value %s stays unannotated through plan and grid, metadata available=%s', async (value, available) => {
  if (!available) backend.DBGetColumns.mockResolvedValue({ success: false, data: [] });
  const statement = `SELECT ${value} AS STATUS FROM customers`;
  const config = { type: 'mysql', host: 'mock.invalid', port: 3306, user: 'test', database: 'lab' };
  const plan = await resolveQueryLocatorPlan({ statement, dbType: 'mysql', currentDb: 'lab', config, forceReadOnly: false, deferColumnMetaBackfill: true });
  expect(plan.tableRef?.tableName).toBe('customers');
  expect(plan.editLocator).toBeUndefined();
  await backfillQueryEditorStatementPlans({
    statementPlans: [plan], sourceStatements: [statement], executedSourceStatements: [statement],
    dbType: 'mysql', currentDb: 'lab', config, isCurrentRun: () => true,
  });
  const preparedColumnRequests = backend.DBGetColumns.mock.calls.length;
  expect(preparedColumnRequests).toBeGreaterThan(0);
  let metadata: ReturnType<typeof useDataGridMetadata> | undefined;
  function Harness() {
    metadata = useDataGridMetadata({
      connections: [{ id: 'mysql', config }], connectionId: 'mysql', dbName: 'lab',
      tableName: plan.tableRef?.metadataTableName, exportScope: 'queryResult', visibleColumnNames: ['STATUS'],
      loading: false, initialColumnMetaMap: plan.columnMetaMap,
    });
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<Harness />); });
    expect(metadata?.columnMetaMapByLowerName.status).toBeUndefined();
    expect(metadata?.getColumnFilterType('STATUS')).toBe('');
    expect(backend.DBGetColumns).toHaveBeenCalledTimes(preparedColumnRequests);
  } finally { act(() => renderer?.unmount()); }
});
