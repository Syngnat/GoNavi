import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareHiveTablePageSQL } from './hiveDataViewer';
import { resetTableMetadataRequestCacheForTests } from '../../utils/tableMetadataRequestCache';

const mocks = vi.hoisted(() => ({ columns: vi.fn() }));
vi.mock('../../../wailsjs/go/app/App', () => ({ DBGetColumns: mocks.columns }));
const config = { type: 'hive', host: 'warehouse', port: 10000, user: '', connectionParams: 'authMode=NOSASL' };

beforeEach(() => { mocks.columns.mockReset(); resetTableMetadataRequestCacheForTests(); });

describe('Hive data viewer page preparation', () => {
  it('does not need metadata for LIMIT-only first pages', async () => {
    expect(await prepareHiveTablePageSQL(config, 'c', 'default', 'events', 'SELECT * FROM events', '', 21, 0)).toBe('SELECT * FROM events LIMIT 21');
    expect(mocks.columns).not.toHaveBeenCalled();
  });

  it('uses only real columns in the outer projection and shares cached metadata', async () => {
    mocks.columns.mockResolvedValue({ success: true, data: [{ name: 'id' }, { name: 'payload' }] });
    const sql = await prepareHiveTablePageSQL(config, 'c', 'default', 'events', 'SELECT * FROM events', ' ORDER BY id', 21, 20);
    expect(sql).toMatch(/^SELECT \x60id\x60, \x60payload\x60 FROM/);
    expect(sql).not.toContain('OFFSET');
    expect(mocks.columns).toHaveBeenCalledTimes(1);
    await prepareHiveTablePageSQL(config, 'c', 'default', 'events', 'SELECT * FROM events', ' ORDER BY id', 21, 40);
    expect(mocks.columns).toHaveBeenCalledTimes(1);
  });

  it.each([{ success: false, message: 'metadata unavailable' }, { success: true, data: [] }])('fails closed when projections cannot be discovered: %s', async result => {
    mocks.columns.mockResolvedValue(result);
    await expect(prepareHiveTablePageSQL(config, 'c', 'default', 'events', 'SELECT * FROM events', '', 21, 20)).rejects.toThrow();
  });
});
