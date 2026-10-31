// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearQueryResultColumnMetaBackfillCache,
  resolveQueryResultColumnMetaByCandidateTables,
} from './queryEditorColumnMetaBackfill';
import { clearLocatorMetaCache } from '../../utils/queryLocatorMetaCache';
import { SIDEBAR_DATABASE_REFRESH_EVENT } from '../../utils/sidebarDatabaseRefresh';

const backendApp = vi.hoisted(() => ({ DBGetColumns: vi.fn() }));

vi.mock('../../../wailsjs/go/app/App', () => backendApp);

const config = {
  id: 'conn-kingbase',
  dbType: 'kingbase',
  host: '127.0.0.1',
  port: 15435,
  user: 'gonavi',
  password: '',
  database: 'kingbase',
};

const request = {
  statement: 'SELECT * FROM demo_cols',
  dbType: 'kingbase',
  currentDb: 'kingbase',
  defaultSchema: 'public',
  config,
};

const columns = [
  { name: 'id', type: 'integer', comment: '主键ID', nullable: 'NO', key: 'PRI' },
  { name: 'user_name', type: 'character varying(64)', comment: '用户名', nullable: 'YES', key: '' },
];

// 软超时是 1s（COLUMN_META_BACKFILL_TIMEOUT_MS），这里显式等过去再看第二次请求。
const waitPastSoftTimeout = () => new Promise((resolve) => { setTimeout(resolve, 1200); });

describe('query result column meta backfill cache', () => {
  beforeEach(() => {
    backendApp.DBGetColumns.mockReset();
    clearQueryResultColumnMetaBackfillCache();
    clearLocatorMetaCache();
  });

  it('does not poison the negative cache when the request fails', async () => {
    backendApp.DBGetColumns.mockResolvedValue({ success: false, message: 'boom', data: [] });
    expect(await resolveQueryResultColumnMetaByCandidateTables(request)).toBeUndefined();

    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: columns });
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables(request);

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
    expect(metaMap?.['id']?.comment).toBe('主键ID');
    expect(metaMap?.['user_name']?.type).toBe('character varying(64)');
  });

  it('does not poison the negative cache when the soft timeout fires', async () => {
    backendApp.DBGetColumns.mockImplementationOnce(() => new Promise(() => undefined));
    expect(await resolveQueryResultColumnMetaByCandidateTables(request)).toBeUndefined();

    await waitPastSoftTimeout();

    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: columns });
    const metaMap = await resolveQueryResultColumnMetaByCandidateTables(request);

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
    expect(metaMap?.['id']?.comment).toBe('主键ID');
  });

  it('keeps deduplicating a table that genuinely has no columns', async () => {
    backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [] });
    expect(await resolveQueryResultColumnMetaByCandidateTables(request)).toBeUndefined();
    expect(await resolveQueryResultColumnMetaByCandidateTables(request)).toBeUndefined();

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(1);
  });

  it('does not let a late response replace columns fetched after DDL invalidation', async () => {
    vi.useFakeTimers();
    try {
      let resolveLate: (value: unknown) => void = () => undefined;
      backendApp.DBGetColumns.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
      const first = resolveQueryResultColumnMetaByCandidateTables(request);
      await vi.advanceTimersByTimeAsync(1100);
      expect(await first).toBeUndefined();
      window.dispatchEvent(new CustomEvent(SIDEBAR_DATABASE_REFRESH_EVENT));
      backendApp.DBGetColumns.mockResolvedValue({ success: true, data: [{ ...columns[0], comment: 'latest' }] });
      expect((await resolveQueryResultColumnMetaByCandidateTables(request))?.id?.comment).toBe('latest');
      resolveLate({ success: true, data: columns });
      await vi.advanceTimersByTimeAsync(0);
      expect((await resolveQueryResultColumnMetaByCandidateTables(request))?.id?.comment).toBe('latest');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fills the cache from a late response that arrived after the soft timeout', async () => {
    let resolveLate: (value: unknown) => void = () => undefined;
    backendApp.DBGetColumns.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
    expect(await resolveQueryResultColumnMetaByCandidateTables(request)).toBeUndefined();

    resolveLate({ success: true, data: columns });
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    const metaMap = await resolveQueryResultColumnMetaByCandidateTables(request);
    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(1);
    expect(metaMap?.['id']?.comment).toBe('主键ID');
  });
});
