import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../../i18n';
import {
  runSidebarMultiTableClear,
  runSidebarMultiTableDrop,
  runSidebarMultiTableTruncate,
} from './sidebarMultiTableActions';

const mocks = vi.hoisted(() => ({
  clearTables: vi.fn(),
  confirmModal: vi.fn(),
  confirmProduction: vi.fn(),
  countdownConfirm: vi.fn(),
  dropTable: vi.fn(),
  error: vi.fn(),
  hide: vi.fn(),
  loading: vi.fn(),
  success: vi.fn(),
  truncateTables: vi.fn(),
}));

vi.mock('antd', () => ({
  Modal: { confirm: mocks.confirmModal },
  message: {
    loading: mocks.loading,
    success: mocks.success,
    error: mocks.error,
  },
}));

vi.mock('../common/countdownDangerConfirm', () => ({
  showCountdownDangerConfirm: mocks.countdownConfirm,
}));

vi.mock('../../utils/productionRiskConfirm', () => ({
  confirmProductionMutation: mocks.confirmProduction,
}));

vi.mock('../../../wailsjs/go/app/App', () => ({
  ClearTables: mocks.clearTables,
  DropTable: mocks.dropTable,
  TruncateTables: mocks.truncateTables,
}));

const nodes = ['orders', 'customers', 'events'].map((tableName) => ({
  key: `conn-1-shop-${tableName}`,
  type: 'table',
  title: tableName,
  dataRef: {
    id: 'conn-1',
    dbName: 'shop',
    schemaName: '',
    tableName,
    config: { type: 'mysql' },
  },
}));

const buildDeps = () => ({
  buildRuntimeConfig: (conn: any, dbName?: string) => ({ ...conn.config, database: dbName }),
  loadTables: vi.fn(async () => undefined),
  getDatabaseNodeRef: vi.fn(() => null),
});

describe('sidebar multi-table danger actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentLanguage('zh-CN');
    mocks.confirmProduction.mockResolvedValue(true);
    mocks.loading.mockReturnValue(mocks.hide);
    mocks.truncateTables.mockResolvedValue({ success: true });
    mocks.clearTables.mockResolvedValue({ success: true });
    mocks.dropTable.mockResolvedValue({ success: true });
  });

  it('passes every selected table to the batch truncate API', async () => {
    const deps = buildDeps();
    const operation = runSidebarMultiTableTruncate(deps, nodes);

    await vi.waitFor(() => expect(mocks.confirmModal).toHaveBeenCalledTimes(1));
    expect(mocks.confirmModal.mock.calls[0][0].title).toBe('截断 3 张表？');
    await mocks.confirmModal.mock.calls[0][0].onOk();
    await operation;

    expect(mocks.truncateTables).toHaveBeenCalledWith(expect.anything(), 'shop', [
      'orders',
      'customers',
      'events',
    ]);
    expect(deps.loadTables).toHaveBeenCalledTimes(1);
  });

  it('passes every selected table to the batch clear API', async () => {
    const deps = buildDeps();
    const operation = runSidebarMultiTableClear(deps, nodes);

    await vi.waitFor(() => expect(mocks.confirmModal).toHaveBeenCalledTimes(1));
    expect(mocks.confirmModal.mock.calls[0][0].title).toBe('清空 3 张表？');
    await mocks.confirmModal.mock.calls[0][0].onOk();
    await operation;

    expect(mocks.clearTables).toHaveBeenCalledWith(expect.anything(), 'shop', [
      'orders',
      'customers',
      'events',
    ]);
    expect(deps.loadTables).toHaveBeenCalledTimes(1);
  });

  it('drops every selected table and refreshes the database once', async () => {
    const deps = buildDeps();
    runSidebarMultiTableDrop(deps, nodes);

    expect(mocks.countdownConfirm).toHaveBeenCalledTimes(1);
    await mocks.countdownConfirm.mock.calls[0][0].onOk();

    expect(mocks.dropTable.mock.calls.map((call) => call[2])).toEqual([
      'orders',
      'customers',
      'events',
    ]);
    expect(deps.loadTables).toHaveBeenCalledTimes(1);
  });
});
