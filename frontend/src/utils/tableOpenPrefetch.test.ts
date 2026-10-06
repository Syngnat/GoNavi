import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  DBGetColumns: vi.fn(),
  DBGetIndexes: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => backend);

import { prefetchTableOpenMetadata } from './tableOpenPrefetch';
import { requestTableMetadata, resetTableMetadataRequestCacheForTests } from './tableMetadataRequestCache';

const connection = (type: string) => ({
  config: { type, host: 'db.internal', port: 5432, user: 'app', password: '', database: 'shop' },
});

describe('prefetchTableOpenMetadata', () => {
  beforeEach(() => {
    resetTableMetadataRequestCacheForTests();
    backend.DBGetColumns.mockReset().mockResolvedValue({ success: true, data: [{ name: 'id' }] });
    backend.DBGetIndexes.mockReset().mockResolvedValue({ success: true, data: [] });
  });

  it('starts the column and index requests the row grid is about to wait for, and the tab reuses them', async () => {
    prefetchTableOpenMetadata({
      connection: connection('postgres'), connectionId: 'conn-1', dbName: 'shop', tableName: 'public.orders', view: 'data',
    });

    expect(backend.DBGetColumns).toHaveBeenCalledWith(expect.anything(), 'shop', 'public.orders');
    expect(backend.DBGetIndexes).toHaveBeenCalledWith(expect.anything(), 'shop', 'public.orders');

    const tabLoader = vi.fn();
    const columns = await requestTableMetadata(
      { connectionId: 'conn-1', dbName: 'shop', tableName: 'public.orders', kind: 'columns' },
      tabLoader,
    );
    expect(columns).toEqual({ success: true, data: [{ name: 'id' }] });
    expect(tabLoader).not.toHaveBeenCalled();
  });

  it('only loads the columns for the structure designer', () => {
    prefetchTableOpenMetadata({
      connection: connection('mysql'), connectionId: 'conn-1', dbName: 'shop', tableName: 'orders', view: 'fields',
    });

    expect(backend.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(backend.DBGetIndexes).not.toHaveBeenCalled();
  });

  it('leaves the Kingbase row grid alone, whose page query has to go out first', () => {
    prefetchTableOpenMetadata({
      connection: connection('kingbase'), connectionId: 'conn-1', dbName: 'shop', tableName: 'public.orders', view: 'data',
    });
    expect(backend.DBGetColumns).not.toHaveBeenCalled();
    expect(backend.DBGetIndexes).not.toHaveBeenCalled();

    prefetchTableOpenMetadata({
      connection: connection('kingbase'), connectionId: 'conn-1', dbName: 'shop', tableName: 'public.orders', view: 'fields',
    });
    expect(backend.DBGetColumns).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a connection or a table name', () => {
    prefetchTableOpenMetadata({ connection: undefined, connectionId: 'conn-1', dbName: 'shop', tableName: 'orders', view: 'data' });
    prefetchTableOpenMetadata({ connection: connection('mysql'), connectionId: 'conn-1', dbName: 'shop', tableName: ' ', view: 'data' });

    expect(backend.DBGetColumns).not.toHaveBeenCalled();
  });
});
