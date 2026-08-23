import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requestTableMetadata,
  resetTableMetadataRequestCacheForTests,
} from './tableMetadataRequestCache';

const requestKey = {
  connectionId: 'conn-1',
  dbName: 'ldf_server_dbs',
  tableName: 'ldf_server.andon_dash_events',
  kind: 'columns' as const,
};

describe('table metadata request cache', () => {
  afterEach(() => {
    resetTableMetadataRequestCacheForTests();
  });

  it('coalesces concurrent requests and briefly reuses the settled result', async () => {
    let resolveRequest!: (value: { success: boolean }) => void;
    const loader = vi.fn(() => new Promise<{ success: boolean }>((resolve) => {
      resolveRequest = resolve;
    }));

    const first = requestTableMetadata(requestKey, loader);
    const concurrent = requestTableMetadata(requestKey, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(concurrent).toBe(first);

    resolveRequest({ success: true });
    await expect(first).resolves.toEqual({ success: true });

    const settled = requestTableMetadata(requestKey, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(settled).toBe(first);
  });

  it('supports an explicit refresh and retries after a rejected request', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('metadata failed'))
      .mockResolvedValue({ success: true });

    await expect(requestTableMetadata(requestKey, loader)).rejects.toThrow('metadata failed');
    await expect(requestTableMetadata(requestKey, loader)).resolves.toEqual({ success: true });
    await expect(requestTableMetadata(requestKey, loader, { force: true })).resolves.toEqual({ success: true });

    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('keeps metadata requests isolated by connection parameters', async () => {
    const salesLoader = vi.fn().mockResolvedValue({ schema: 'sales' });
    const publicLoader = vi.fn().mockResolvedValue({ schema: 'public' });

    await expect(requestTableMetadata(
      { ...requestKey, connectionParams: 'search_path=sales%2Cpublic' },
      salesLoader,
    )).resolves.toEqual({ schema: 'sales' });
    await expect(requestTableMetadata(
      { ...requestKey, connectionParams: 'search_path=public' },
      publicLoader,
    )).resolves.toEqual({ schema: 'public' });

    expect(salesLoader).toHaveBeenCalledTimes(1);
    expect(publicLoader).toHaveBeenCalledTimes(1);
  });
});
