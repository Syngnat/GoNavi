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

  const Harness: React.FC<{ connectionParamsOverride: string }> = ({ connectionParamsOverride }) => {
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
});
