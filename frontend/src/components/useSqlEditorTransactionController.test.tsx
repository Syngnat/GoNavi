import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSqlEditorTransactionController } from './useSqlEditorTransactionController';
import type { PendingSqlEditorTransaction } from './QueryEditorTransactionToolbar';
import { t as catalogTranslate } from '../i18n/catalog';

const storeState = vi.hoisted(() => ({
  setSqlEditorPendingTransaction: vi.fn(),
  addSqlLog: vi.fn(),
  connections: [] as Array<{ id: string; name: string; environmentType?: string; config: Record<string, unknown> }>,
}));

const productionRisk = vi.hoisted(() => ({
  confirmProductionRisk: vi.fn(),
  // 与真实实现同构：只有"生产环境且未配置任何保护"才需要确认。
  // 用真实判定而非恒真 stub，否则"开发连接不弹窗"这类回归会被 mock 掩盖。
  requiresProductionRiskConfirmation: vi.fn(
    (connection: { environmentType?: string; config?: { protection?: unknown } } | null | undefined) => (
      String(connection?.environmentType || '').trim().toLowerCase() === 'production'
      && !(connection?.config as any)?.protection
    ),
  ),
}));

const backendApp = vi.hoisted(() => ({
  DBCommitTransactionWithTrigger: vi.fn(),
  DBRollbackTransactionWithTrigger: vi.fn(),
}));

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

// useStore 既是 selector 调用（订阅 setter），也被 getState() 用于按需读连接列表，
// 两者都要支持，否则 mock 与真实 store 的差异会掩盖提交前的连接解析。
vi.mock('../store', () => {
  const useStore = (selector: (state: typeof storeState) => unknown) => selector(storeState);
  useStore.getState = () => storeState;
  return { useStore };
});

vi.mock('../utils/productionRiskConfirm', () => productionRisk);

vi.mock('../../wailsjs/go/app/App', () => backendApp);

vi.mock('antd', () => ({
  message: messageApi,
}));

const TEST_CONNECTION_ID = 'conn-1';

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
  connectionId: TEST_CONNECTION_ID,
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
    storeState.connections = [{
      id: TEST_CONNECTION_ID,
      name: 'local-mysql',
      environmentType: 'development',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306 },
    }];
    backendApp.DBCommitTransactionWithTrigger.mockReset();
    backendApp.DBRollbackTransactionWithTrigger.mockReset();
    messageApi.error.mockReset();
    messageApi.success.mockReset();
    messageApi.warning.mockReset();
    productionRisk.confirmProductionRisk.mockReset();
    productionRisk.confirmProductionRisk.mockResolvedValue(true);
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

  it('keeps the transaction open when production confirmation is declined', async () => {
    productionRisk.confirmProductionRisk.mockResolvedValue(false);
    renderController();

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({
        connectionId: 'conn-production',
      }));
    });
    storeState.connections = [{
      id: 'conn-production',
      name: 'prod-mysql',
      environmentType: 'production',
      config: { type: 'mysql', host: '10.0.0.1', port: 3306 },
    }];

    await act(async () => {
      await controller?.finishPendingSqlTransaction('commit', 'manual');
    });

    // 被拒后数据库侧事务仍然打开，本地状态必须原样保留，
    // 否则 UI 不再显示提交/回滚入口，而事务还持着锁。
    expect(backendApp.DBCommitTransactionWithTrigger).not.toHaveBeenCalled();
    expect(controller?.pendingSqlTransaction).not.toBeNull();
    expect(controller?.pendingSqlTransaction?.id).toBe('tx-1');
    expect(storeState.setSqlEditorPendingTransaction).toHaveBeenLastCalledWith('tab-1', expect.objectContaining({ id: 'tx-1' }));
  });

  it('gates the commit on the connection captured when the transaction opened', async () => {
    renderController();

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({
        connectionId: 'conn-production',
      }));
    });
    storeState.connections = [{
      id: 'conn-production',
      name: 'prod-mysql',
      environmentType: 'production',
      config: { type: 'mysql', host: '10.0.0.1', port: 3306 },
    }];

    await act(async () => {
      await controller?.finishPendingSqlTransaction('commit', 'manual');
    });

    expect(productionRisk.confirmProductionRisk).toHaveBeenCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ id: 'conn-production', name: 'prod-mysql' }),
    }));
  });

  it('does not gate rollback on production confirmation', async () => {
    renderController();

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({
        connectionId: 'conn-production',
      }));
    });
    storeState.connections = [{
      id: 'conn-production',
      name: 'prod-mysql',
      environmentType: 'production',
      config: { type: 'mysql', host: '10.0.0.1', port: 3306 },
    }];

    await act(async () => {
      await controller?.finishPendingSqlTransaction('rollback', 'manual');
    });

    // 回滚是撤销操作，加门禁只会让用户更难从生产环境退出。
    expect(productionRisk.confirmProductionRisk).not.toHaveBeenCalled();
    expect(backendApp.DBRollbackTransactionWithTrigger).toHaveBeenCalledWith('tx-1', 'manual');
  });

  it('downgrades to manual commit when an automatic commit is declined', async () => {
    productionRisk.confirmProductionRisk.mockResolvedValue(false);
    renderController();

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({
        connectionId: 'conn-production',
        commitMode: 'auto',
        autoCommitDelayMs: 0,
      }));
    });
    storeState.connections = [{
      id: 'conn-production',
      name: 'prod-mysql',
      environmentType: 'production',
      config: { type: 'mysql', host: '10.0.0.1', port: 3306 },
    }];

    await act(async () => {
      await controller?.finishPendingSqlTransaction('commit', 'auto');
    });

    // 不能停在"自动提交中"：倒计时已清、提交按钮须可用，由用户显式决定。
    expect(backendApp.DBCommitTransactionWithTrigger).not.toHaveBeenCalled();
    expect(controller?.pendingSqlTransaction?.commitMode).toBe('manual');
    expect(controller?.pendingSqlTransaction?.autoCommitDueAt).toBeNull();
  });

  it('fails closed when the transaction connection can no longer be resolved', async () => {
    renderController({ translate });

    await act(async () => {
      controller?.activatePendingSqlTransaction(createPendingTransaction({
        connectionId: 'conn-deleted',
      }));
      await controller?.finishPendingSqlTransaction('commit', 'manual');
    });

    // 连接查不到时不得放行：confirmProductionRisk 对 null 会直接返回 true，
    // 走它的 null 分支等于让不可解析的连接绕过生产确认。
    expect(productionRisk.confirmProductionRisk).not.toHaveBeenCalled();
    expect(backendApp.DBCommitTransactionWithTrigger).not.toHaveBeenCalled();
    expect(messageApi.error).toHaveBeenLastCalledWith('Connection not found.');
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
