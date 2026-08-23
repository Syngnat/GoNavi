import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSqlEditorTransactionController } from './useSqlEditorTransactionController';
import type { PendingSqlEditorTransaction } from './QueryEditorTransactionToolbar';
import { t as catalogTranslate } from '../i18n/catalog';

const storeState = vi.hoisted(() => ({
  setSqlEditorPendingTransaction: vi.fn(),
  addSqlLog: vi.fn(),
}));

const backendApp = vi.hoisted(() => ({
  DBCommitTransactionWithTrigger: vi.fn(),
  DBRollbackTransactionWithTrigger: vi.fn(),
}));

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../../wailsjs/go/app/App', () => backendApp);

vi.mock('antd', () => ({
  message: messageApi,
}));

const createPendingTransaction = (overrides: Partial<PendingSqlEditorTransaction> = {}): PendingSqlEditorTransaction => ({
  id: 'tx-1',
  commitMode: 'manual',
  autoCommitDelayMs: 0,
  createdAt: Date.now(),
  statementCount: 1,
  dbType: 'mysql',
  dbName: 'main',
  statements: ["UPDATE users SET name = 'new' WHERE id = 1"],
  executionDurationMs: 29,
  ...overrides,
});

describe('useSqlEditorTransactionController', () => {
  let controller: ReturnType<typeof useSqlEditorTransactionController> | null = null;
  let renderer: ReactTestRenderer | null = null;

  const translate = (key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params);

  const renderController = (overrides: Record<string, unknown> = {}) => {
    const Harness = () => {
      controller = (useSqlEditorTransactionController as any)({ tabId: 'tab-1', ...overrides });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
  };

  beforeEach(() => {
    controller = null;
    renderer = null;
    storeState.setSqlEditorPendingTransaction.mockReset();
    storeState.addSqlLog.mockReset();
    backendApp.DBCommitTransactionWithTrigger.mockReset();
    backendApp.DBRollbackTransactionWithTrigger.mockReset();
    messageApi.error.mockReset();
    messageApi.success.mockReset();
    backendApp.DBCommitTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已提交' });
    backendApp.DBRollbackTransactionWithTrigger.mockResolvedValue({ success: true, message: '事务已回滚' });
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
  });

  it('ignores duplicate finish requests for the same pending transaction', async () => {
    renderController();

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction());
    });

    await act(async () => {
      const first = controller?.finishPendingSqlTransaction('commit', 'manual');
      const second = controller?.finishPendingSqlTransaction('commit', 'manual');
      await Promise.all([first, second]);
    });

    expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledTimes(1);
    expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-1', 'manual');
    expect(backendApp.DBRollbackTransactionWithTrigger).not.toHaveBeenCalled();
    expect(messageApi.success).toHaveBeenCalledWith('事务已提交');
    expect(storeState.addSqlLog).toHaveBeenCalledTimes(1);
  });

  it('writes the complete managed transaction to the SQL log after commit', async () => {
    renderController();
    const transaction = createPendingTransaction();

    await act(async () => {
      controller?.activatePendingSqlTransaction(transaction);
      await controller?.finishPendingSqlTransaction('commit', 'manual');
    });

    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: "START TRANSACTION;\nUPDATE users SET name = 'new' WHERE id = 1;\nCOMMIT;",
      status: 'success',
      dbName: 'main',
      duration: expect.any(Number),
      category: 'transaction',
      transactionId: 'tx-1',
      transactionAction: 'commit',
    }));
  });

  it('writes the complete managed transaction to the SQL log after rollback', async () => {
    renderController();

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({ dbType: 'sqlserver' }));
      await controller?.finishPendingSqlTransaction('rollback', 'manual');
    });

    expect(storeState.addSqlLog).toHaveBeenCalledWith(expect.objectContaining({
      sql: "BEGIN TRANSACTION;\nUPDATE users SET name = 'new' WHERE id = 1;\nROLLBACK TRANSACTION;",
      status: 'success',
      dbName: 'main',
    }));
  });

  it('does not rollback a transaction while its auto commit is in flight', async () => {
    let resolveCommit!: (value: { success: boolean; message: string }) => void;
    backendApp.DBCommitTransactionWithTrigger.mockReturnValue(new Promise((resolve) => {
      resolveCommit = resolve;
    }));
    renderController();

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({
        commitMode: 'auto',
        autoCommitDelayMs: 0,
      }));
    });

    const finishPromise = controller?.finishPendingSqlTransaction('commit', 'auto');
    act(() => {
      renderer?.unmount();
      renderer = null;
    });

    expect(backendApp.DBRollbackTransactionWithTrigger).not.toHaveBeenCalled();
    expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledTimes(1);
    expect(backendApp.DBCommitTransactionWithTrigger).toHaveBeenCalledWith('tx-1', 'auto');

    await act(async () => {
      resolveCommit({ success: true, message: '事务已提交' });
      await finishPromise;
    });

    expect(messageApi.success).toHaveBeenCalledWith('自动提交成功');
  });

  it('marks the automatic rollback source when the editor unmounts', async () => {
    renderController();

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction());
    });
    act(() => {
      renderer?.unmount();
      renderer = null;
    });

    expect(backendApp.DBRollbackTransactionWithTrigger).toHaveBeenCalledWith('tx-1', 'tab_close');
  });

  it('uses the active language for transaction success messages', async () => {
    renderController({ translate });

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction());
      await controller?.finishPendingSqlTransaction('commit', 'manual');
    });
    expect(messageApi.success).toHaveBeenLastCalledWith('Transaction committed');

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({ id: 'tx-2' }));
      await controller?.finishPendingSqlTransaction('rollback', 'manual');
    });
    expect(messageApi.success).toHaveBeenLastCalledWith('Transaction rolled back');

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({ id: 'tx-3' }));
      await controller?.finishPendingSqlTransaction('commit', 'auto');
    });
    expect(messageApi.success).toHaveBeenLastCalledWith('Auto commit succeeded');
  });

  it('uses the active language for transaction failure wrappers and keeps raw error details', async () => {
    backendApp.DBCommitTransactionWithTrigger.mockResolvedValueOnce({
      success: false,
      message: 'ORA-00060: deadlock detected while waiting for resource',
    });
    renderController({ translate });

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction());
      await controller?.finishPendingSqlTransaction('commit', 'manual');
    });

    expect(messageApi.error).toHaveBeenLastCalledWith('Commit failed: ORA-00060: deadlock detected while waiting for resource');
    expect(storeState.addSqlLog).toHaveBeenLastCalledWith(expect.objectContaining({
      sql: expect.stringContaining('COMMIT;'),
      status: 'error',
      message: 'ORA-00060: deadlock detected while waiting for resource',
    }));

    backendApp.DBRollbackTransactionWithTrigger.mockRejectedValueOnce(new Error('SQLSTATE 40001 serialization failure'));

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({ id: 'tx-2' }));
      await controller?.finishPendingSqlTransaction('rollback', 'manual');
    });

    expect(messageApi.error).toHaveBeenLastCalledWith('Rollback failed: SQLSTATE 40001 serialization failure');
    expect(storeState.addSqlLog).toHaveBeenLastCalledWith(expect.objectContaining({
      sql: expect.stringContaining('ROLLBACK;'),
      status: 'error',
      message: 'SQLSTATE 40001 serialization failure',
    }));
  });

  it('keeps an unknown transaction finish outcome visible to the user', async () => {
    backendApp.DBCommitTransactionWithTrigger.mockResolvedValueOnce({
      success: false,
      message: 'commit response lost',
      outcomeUnknown: true,
    });
    renderController({ translate });

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction());
      await controller?.finishPendingSqlTransaction('commit', 'manual');
    });

    expect(messageApi.error).toHaveBeenLastCalledWith('Commit failed: commit response lost (Transaction outcome may be unknown)');
    expect(storeState.addSqlLog).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'error',
      message: 'commit response lost (Transaction outcome may be unknown)',
    }));
  });
});
