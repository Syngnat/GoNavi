import { describe, expect, it, vi } from 'vitest';

import {
  createDriverStatusSnapshotRegistry,
  restoreDriverNetworkSnapshot,
  restoreDriverStatusSnapshot,
  settleLatestDriverRequest,
} from '../utils/driverManagerRequestState';

describe('DriverManagerModal request coordination boundary', () => {
  it('lets only the latest request clear loading, including silent refreshes', () => {
    const setStatusLoading = vi.fn();
    const setNetworkLoading = vi.fn();

    expect(settleLatestDriverRequest(2, 3, setStatusLoading)).toBe(false);
    expect(setStatusLoading).not.toHaveBeenCalled();
    expect(settleLatestDriverRequest(3, 3, setStatusLoading)).toBe(true);
    expect(setStatusLoading).toHaveBeenCalledWith(false);

    expect(settleLatestDriverRequest(7, 7, setNetworkLoading)).toBe(true);
    expect(setNetworkLoading).toHaveBeenCalledWith(false);
  });

  it('restores fresh snapshots and clears cold loading flags', () => {
    const setRows = vi.fn();
    const setStatusLoading = vi.fn();
    const setDownloadDir = vi.fn();
    const setNetworkStatus = vi.fn();
    const setNetworkLoading = vi.fn();
    const rows = [{ type: 'mysql' }];
    const networkStatus = { reachable: true };

    expect(restoreDriverStatusSnapshot({
      rows,
      downloadDir: 'D:/drivers',
      cachedAt: 100,
      intentSequence: 4,
    }, {
      setRows,
      setLoading: setStatusLoading,
      setDownloadDir,
    })).toBe(true);
    expect(setRows).toHaveBeenCalledWith(rows);
    expect(setStatusLoading).toHaveBeenCalledWith(false);
    expect(setDownloadDir).toHaveBeenCalledWith('D:/drivers');

    expect(restoreDriverNetworkSnapshot({ status: networkStatus, cachedAt: 100 }, {
      setStatus: setNetworkStatus,
      setLoading: setNetworkLoading,
    })).toBe(true);
    expect(setNetworkStatus).toHaveBeenCalledWith(networkStatus);
    expect(setNetworkLoading).toHaveBeenCalledWith(false);
  });

  it('keeps status snapshots keyed and rejects writes older than the latest intent', () => {
    const snapshots = createDriverStatusSnapshotRegistry<{ type: string }>();
    const mysqlKey = snapshots.beginRequest('D:/mysql', 2);

    expect(snapshots.write(mysqlKey, {
      rows: [{ type: 'stale' }],
      downloadDir: 'D:/mysql',
      cachedAt: 100,
      intentSequence: 1,
    })).toBe(false);
    expect(snapshots.getPreferred()).toBeNull();

    expect(snapshots.write(mysqlKey, {
      rows: [{ type: 'mysql' }],
      downloadDir: 'D:/mysql',
      cachedAt: 200,
      intentSequence: 2,
    })).toBe(true);
    expect(snapshots.getPreferred()?.rows).toEqual([{ type: 'mysql' }]);

    const postgresKey = snapshots.beginRequest('D:/postgres', 3);
    expect(snapshots.write(postgresKey, {
      rows: [{ type: 'postgres' }],
      downloadDir: 'D:/postgres',
      cachedAt: 300,
      intentSequence: 3,
    })).toBe(true);
    expect(snapshots.getPreferred()?.rows).toEqual([{ type: 'postgres' }]);

    expect(snapshots.write(mysqlKey, {
      rows: [{ type: 'older-mysql' }],
      downloadDir: 'D:/mysql',
      cachedAt: 150,
      intentSequence: 1,
    })).toBe(false);
  });
});
