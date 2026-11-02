import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmMock = vi.hoisted(() => vi.fn());
const messageMock = vi.hoisted(() => ({
    loading: vi.fn(() => vi.fn()),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
}));

vi.mock('./common/ResizableDraggableModal', () => ({
    default: { confirm: confirmMock },
}));
vi.mock('antd', () => ({ message: messageMock }));
vi.mock('../i18n', () => ({
    t: (key: string, params?: Record<string, unknown>) => (
        params ? `${key}:${JSON.stringify(params)}` : key
    ),
}));

import { confirmCopyDatabase } from './databaseCopyAction';

type GoApp = { CopyDatabase?: (config: unknown, dbName: string) => Promise<unknown> };

const installBackend = (impl?: (config: unknown, dbName: string) => Promise<unknown>) => {
    (globalThis as unknown as { go?: { app?: { App?: GoApp } } }).go = {
        app: { App: impl ? { CopyDatabase: impl } : {} },
    };
};

/** 取出 Modal.confirm 的 onOk，模拟用户点确认。 */
const runConfirm = () => confirmMock.mock.calls[0]![0].onOk() as Promise<unknown>;

describe('copy database action', () => {
    beforeEach(() => {
        confirmMock.mockReset();
        messageMock.loading.mockClear();
        messageMock.success.mockClear();
        messageMock.error.mockClear();
        messageMock.warning.mockClear();
    });
    afterEach(() => {
        delete (globalThis as { go?: unknown }).go;
    });

    // 复制整库是重操作，执行前必须先确认，且文案里要给出即将产生的目标库名。
    it('asks for confirmation with the target database name', () => {
        confirmCopyDatabase({ config: {}, dbName: 'shop' });

        expect(confirmMock).toHaveBeenCalledTimes(1);
        const options = confirmMock.mock.calls[0]![0];
        expect(options.title).toBe('database_copy.modal.title');
        expect(options.content).toContain('shop_copy1');
    });

    it('does nothing when the database name is blank', () => {
        confirmCopyDatabase({ config: {}, dbName: '   ' });
        expect(confirmMock).not.toHaveBeenCalled();
    });

    it('calls the backend and reports the created database', async () => {
        const copyDatabase = vi.fn(async () => ({ success: true, data: 'shop_copy1' }));
        installBackend(copyDatabase);
        const onSuccess = vi.fn();

        confirmCopyDatabase({ config: {}, dbName: 'shop', onSuccess });
        await runConfirm();

        expect(copyDatabase).toHaveBeenCalledWith({}, 'shop');
        expect(onSuccess).toHaveBeenCalledWith('shop_copy1');
        expect(messageMock.success).toHaveBeenCalledWith(
            expect.stringContaining('shop_copy1'),
        );
    });

    it('surfaces the backend message when the copy fails', async () => {
        installBackend(async () => ({ success: false, message: 'boom' }));

        confirmCopyDatabase({ config: {}, dbName: 'shop' });
        await expect(runConfirm()).rejects.toThrow('boom');

        expect(messageMock.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    // 后端没给新库名时不能假装成功——界面需要它来提示用户复制到了哪里。
    it('treats a missing target name as a failure', async () => {
        installBackend(async () => ({ success: true }));

        confirmCopyDatabase({ config: {}, dbName: 'shop' });
        await expect(runConfirm()).rejects.toThrow();

        expect(messageMock.error).toHaveBeenCalledWith(
            expect.stringContaining('database_copy.message.target_missing'),
        );
    });

    it('warns instead of failing when only the tree refresh breaks', async () => {
        installBackend(async () => ({ success: true, data: 'shop_copy1' }));

        confirmCopyDatabase({
            config: {},
            dbName: 'shop',
            onSuccess: async () => { throw new Error('refresh broke'); },
        });
        await runConfirm();

        expect(messageMock.warning).toHaveBeenCalledWith(
            expect.stringContaining('refresh_failed'),
        );
        expect(messageMock.success).toHaveBeenCalled();
    });

    it('reports an unavailable backend without calling it', async () => {
        installBackend(undefined);

        confirmCopyDatabase({ config: {}, dbName: 'shop' });
        await expect(runConfirm()).rejects.toThrow();

        expect(messageMock.error).toHaveBeenCalledWith(
            'database_copy.message.backend_unavailable',
        );
    });
});
