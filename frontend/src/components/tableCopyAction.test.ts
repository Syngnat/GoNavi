import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import { confirmCopyTable, confirmCopyTables } from './tableCopyAction';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  hide: vi.fn(),
  loading: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  copyTable: vi.fn(),
}));

vi.mock('./common/ResizableDraggableModal', () => ({
  default: { confirm: mocks.confirm },
}));

vi.mock('antd', () => ({
  message: {
    loading: mocks.loading,
    success: mocks.success,
    warning: mocks.warning,
    error: mocks.error,
  },
}));

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('confirmCopyTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentLanguage('zh-CN');
    mocks.loading.mockReturnValue(mocks.hide);
    (globalThis as any).go = {
      app: { App: { CopyTable: mocks.copyTable } },
    };
  });

  it('confirms before copying and refreshes with the backend-generated table name', async () => {
    const refresh = createDeferred<void>();
    const onSuccess = vi.fn(() => refresh.promise);
    const config = { type: 'mysql' };
    mocks.copyTable.mockResolvedValue({
      success: true,
      data: 'orders_copy2',
    });

    confirmCopyTable({
      config,
      dbName: 'sales',
      sourceSchemaName: 'reporting',
      sourceTableName: 'orders',
      onSuccess,
    });

    expect(mocks.confirm).toHaveBeenCalledOnce();
    const options = mocks.confirm.mock.calls[0][0];
    expect(options.title).toBe('复制整表');
    expect(options.content).toContain('orders');
    expect(options.content).toContain('orders_copy1');
    expect(options.content).toContain('外键、触发器和授权不会复制');

    const operation = options.onOk();

    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith('orders_copy2');
    });
    expect(mocks.success).not.toHaveBeenCalled();

    refresh.resolve();
    await operation;

    expect(mocks.copyTable).toHaveBeenCalledWith(config, 'sales', 'reporting', 'orders');
    expect(mocks.success).toHaveBeenCalledWith('整表复制成功：orders_copy2');
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it('keeps the confirmation open and reports backend failures', async () => {
    mocks.copyTable.mockResolvedValue({
      success: false,
      message: 'copy failed',
    });

    confirmCopyTable({
      config: { type: 'mysql' },
      dbName: 'sales',
      sourceTableName: 'orders',
    });

    const options = mocks.confirm.mock.calls[0][0];
    await expect(options.onOk()).rejects.toThrow('copy failed');
    expect(mocks.error).toHaveBeenCalledWith('整表复制失败：copy failed');
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it('confirms once, copies multiple tables and refreshes after the batch', async () => {
    const onSuccess = vi.fn();
    mocks.copyTable
      .mockResolvedValueOnce({ success: true, data: 'orders_copy1' })
      .mockResolvedValueOnce({ success: true, data: 'customers_copy1' });

    confirmCopyTables({
      config: { type: 'mysql' },
      dbName: 'sales',
      sourceTableNames: ['orders', 'customers'],
      onSuccess,
    });

    expect(mocks.confirm).toHaveBeenCalledOnce();
    const options = mocks.confirm.mock.calls[0][0];
    expect(options.title).toBe('批量复制整表');
    expect(options.content).toContain('2 张表');

    await options.onOk();

    expect(mocks.copyTable).toHaveBeenNthCalledWith(1, { type: 'mysql' }, 'sales', '', 'orders');
    expect(mocks.copyTable).toHaveBeenNthCalledWith(2, { type: 'mysql' }, 'sales', '', 'customers');
    expect(onSuccess).toHaveBeenCalledWith(['orders_copy1', 'customers_copy1']);
    expect(mocks.success).toHaveBeenCalledWith('已复制 2 张表');
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it('reports partial batch failures without keeping the confirmation open', async () => {
    mocks.copyTable
      .mockResolvedValueOnce({ success: true, data: 'orders_copy1' })
      .mockResolvedValueOnce({ success: false, message: 'boom' });

    confirmCopyTables({
      config: { type: 'mysql' },
      dbName: 'sales',
      sourceTableNames: ['orders', 'customers'],
    });
    const options = mocks.confirm.mock.calls[0][0];

    await expect(options.onOk()).resolves.toBeUndefined();

    expect(mocks.warning).toHaveBeenCalledWith(
      expect.stringContaining('已复制 1 张表，1 张失败'),
    );
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it('keeps the batch confirmation open when every table fails', async () => {
    mocks.copyTable.mockResolvedValue({ success: false, message: 'boom' });

    confirmCopyTables({
      config: { type: 'mysql' },
      dbName: 'sales',
      sourceTableNames: ['orders', 'customers'],
    });
    const options = mocks.confirm.mock.calls[0][0];

    await expect(options.onOk()).rejects.toThrow('orders: boom');

    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('2 张表全部复制失败'),
    );
    expect(mocks.hide).toHaveBeenCalledOnce();
  });
});
