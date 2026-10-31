import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTableMetadataRequestCacheForTests } from '../utils/tableMetadataRequestCache';
import { useDataGridMetadata } from './useDataGridMetadata';

const backendApp = vi.hoisted(() => ({
  DBGetColumns: vi.fn(),
  DBGetForeignKeys: vi.fn(),
  DBGetIndexes: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);

describe('useDataGridMetadata execution context', () => {
  let controller: ReturnType<typeof useDataGridMetadata> | null = null;
  let renderer: ReactTestRenderer | null = null;

  const Harness: React.FC<{
    connectionParamsOverride: string;
    initialColumnMetaMap?: Record<string, any>;
    initialUniqueKeyGroups?: string[][];
  }> = ({ connectionParamsOverride, initialColumnMetaMap, initialUniqueKeyGroups }) => {
    controller = useDataGridMetadata({
      connections: [{
        id: 'conn-1',
        config: {
          type: 'postgres',
          host: '127.0.0.1',
          port: 5432,
          connectionParams: connectionParamsOverride,
        },
      }],
      connectionId: 'conn-1',
      connectionParamsOverride,
      dbName: 'app',
      tableName: 'users',
      exportScope: 'queryResult',
      visibleColumnNames: ['value'],
      loading: false,
      initialColumnMetaMap,
      initialUniqueKeyGroups,
    });
    return null;
  };

  beforeEach(() => {
    controller = null;
    renderer = null;
    resetTableMetadataRequestCacheForTests();
    backendApp.DBGetColumns.mockReset().mockImplementation(async (config: any) => ({
      success: true,
      data: [{
        name: String(config?.connectionParams || '').includes('sales') ? 'sales_value' : 'public_value',
        type: 'text',
      }],
    }));
    backendApp.DBGetForeignKeys.mockReset().mockResolvedValue({ success: true, data: [] });
    backendApp.DBGetIndexes.mockReset().mockResolvedValue({ success: true, data: [] });
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    resetTableMetadataRequestCacheForTests();
  });

  it('reloads metadata when the same table moves to another search_path', async () => {
    await act(async () => {
      renderer = create(<Harness connectionParamsOverride="search_path=sales%2Cpublic" />);
    });

    expect(controller?.columnMetaMap).toHaveProperty('sales_value');

    await act(async () => {
      renderer?.update(<Harness connectionParamsOverride="search_path=public" />);
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
    expect(controller?.columnMetaMap).toHaveProperty('public_value');
    expect(controller?.columnMetaMap).not.toHaveProperty('sales_value');
  });

  it('merges primary, unique, and secondary index roles into column meta', async () => {
    backendApp.DBGetColumns.mockResolvedValue({
      success: true,
      data: [
        { name: 'id', type: 'bigint', key: 'PRI' },
        { name: 'email', type: 'varchar' },
        { name: 'city', type: 'varchar' },
      ],
    });
    backendApp.DBGetIndexes.mockResolvedValue({
      success: true,
      data: [
        { name: 'users_pkey', columnName: 'id', nonUnique: 0, seqInIndex: 1, indexType: 'BTREE' },
        { name: 'users_email_key', columnName: 'email', nonUnique: 0, seqInIndex: 1, indexType: 'BTREE' },
        { name: 'idx_users_city', columnName: 'city', nonUnique: 1, seqInIndex: 1, indexType: 'BTREE' },
      ],
    });

    await act(async () => {
      renderer = create(<Harness connectionParamsOverride="search_path=public" />);
    });

    expect(controller?.columnMetaMap.id).toMatchObject({ type: 'bigint', key: 'PRI' });
    expect(controller?.columnMetaMap.email).toMatchObject({ type: 'varchar', key: 'UNI' });
    expect(controller?.columnMetaMap.city).toMatchObject({ type: 'varchar', key: 'MUL' });
  });

  it('does not replace empty metadata after the first query-result paint', async () => {
    const snapshots: ReturnType<typeof useDataGridMetadata>[] = [];
    const EmptyQuery = () => {
      snapshots.push(useDataGridMetadata({ connections: [], connectionId: '', tableName: '',
        dbName: '', exportScope: 'queryResult', visibleColumnNames: ['value'], loading: false }));
      return null;
    };
    await act(async () => { renderer = create(<EmptyQuery />); });
    expect(snapshots).toHaveLength(1);
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
  });

  it('does not cache an authoritative empty query projection as table metadata during same-table transitions', async () => {
    const Snapshot = ({ initial, loading = false }: { initial?: Record<string, { type?: string; comment?: string }>; loading?: boolean }) => {
      controller = useDataGridMetadata({ connections: [{ id: 'kingbase', config: { type: 'kingbase', host: 'mock.invalid', port: 54321 } }],
        connectionId: 'kingbase', dbName: 'lab', tableName: 'customers', exportScope: 'queryResult', visibleColumnNames: ['name'],
        loading, initialColumnMetaMap: initial });
      return null;
    };
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [{ name: 'name', type: 'varchar', comment: 'customer name' }] });
    await act(async () => { renderer = create(<Snapshot initial={{}} />); });
    expect(controller?.columnMetaMap).toEqual({});
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    await act(async () => { renderer?.update(<Snapshot initial={undefined} loading />); });
    expect(controller?.columnMetaMap).toEqual({});
    await act(async () => { renderer?.update(<Snapshot initial={undefined} />); });
    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(controller?.columnMetaMap.name.comment).toBe('customer name');
    await act(async () => { renderer?.update(<Snapshot initial={{}} />); });
    expect(controller?.columnMetaMap).toEqual({});
    await act(async () => { renderer?.update(<Snapshot initial={{ name: { type: 'varchar', comment: 'new comment' } }} />); });
    expect(controller?.columnMetaMap.name.comment).toBe('new comment');
    await act(async () => { renderer?.update(<Snapshot initial={{}} loading />); });
    expect(controller?.columnMetaMap).toEqual({});
  });

  it('keeps the previous non-Kingbase fallback when the supplied map is empty', async () => {
    await act(async () => { renderer = create(<Harness connectionParamsOverride="search_path=public" initialColumnMetaMap={{}} />); });
    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(controller?.columnMetaMap).toHaveProperty('public_value');
  });

  it('uses execution-plan metadata without requesting the same table again', async () => {
    const initialColumnMetaMap = {
      id: { type: 'bigint', comment: '', nullable: 'NO', default: '', hasDefault: false, extra: '', key: 'PRI' },
    };

    await act(async () => {
      renderer = create(
        <Harness
          connectionParamsOverride="search_path=public"
          initialColumnMetaMap={initialColumnMetaMap}
          initialUniqueKeyGroups={[["id"]]}
        />,
      );
    });

    expect(controller?.columnMetaMap).toBe(initialColumnMetaMap);
    expect(controller?.uniqueKeyGroups).toEqual([['id']]);
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
  });

  it('renders prepared query metadata once and retains it when the query context changes', async () => {
    const snapshots: ReturnType<typeof useDataGridMetadata>[] = [];
    const columns = { id: { type: 'bigint', key: 'PRI', comment: '' } };
    const keys = [['id']];
    const PreparedQuery = ({ table }: { table: string }) => {
      snapshots.push(useDataGridMetadata({ connections: [], connectionId: 'conn-1', dbName: 'app',
        tableName: table, exportScope: 'queryResult', visibleColumnNames: ['id'], loading: false,
        initialColumnMetaMap: columns, initialUniqueKeyGroups: keys }));
      return null;
    };
    await act(async () => { renderer = create(<PreparedQuery table="users" />); });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].columnMetaMap).toBe(columns);
    expect(snapshots[0].uniqueKeyGroups).toBe(keys);
    await act(async () => { renderer?.update(<PreparedQuery table="archived_users" />); });
    expect(snapshots).toHaveLength(2);
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
    expect(backendApp.DBGetIndexes).not.toHaveBeenCalled();
  });

  it('keeps backfilled metadata when the statement cannot be pinned to a single table', async () => {
    const snapshots: ReturnType<typeof useDataGridMetadata>[] = [];
    // 复杂 SQL（JOIN/GROUP BY）定位不到单表，metadata 由执行计划按列名回填后经 initialColumnMetaMap 传入
    const columns = { name: { type: 'character varying(50)', comment: '客户姓名' } };
    const MultiTableQuery = () => {
      snapshots.push(useDataGridMetadata({
        connections: [], connectionId: 'conn-1', dbName: 'app', tableName: '',
        exportScope: 'queryResult', visibleColumnNames: ['name'], loading: false,
        initialColumnMetaMap: columns,
      }));
      return null;
    };
    await act(async () => { renderer = create(<MultiTableQuery />); });
    expect(snapshots[0].columnMetaMap).toBe(columns);
    expect(backendApp.DBGetColumns).not.toHaveBeenCalled();
  });
});
