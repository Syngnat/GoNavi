import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';

import { DBCommitTransactionWithTrigger, DBRollbackTransactionWithTrigger } from '../../wailsjs/go/app/App';
import { t as catalogTranslate } from '../i18n/catalog';
import { useStore } from '../store';
import { confirmProductionRisk, requiresProductionRiskConfirmation } from '../utils/productionRiskConfirm';
import type { PendingSqlEditorTransaction } from './QueryEditorTransactionToolbar';
import { buildSqlEditorTransactionLog } from './sqlEditorTransactionLog';

type FinishSqlEditorTransactionAction = 'commit' | 'rollback';
type FinishSqlEditorTransactionSource = 'manual' | 'auto';
type TranslateParams = Record<string, string | number | boolean | null | undefined>;

type UseSqlEditorTransactionControllerOptions = {
  tabId: string;
  translate?: (key: string, params?: TranslateParams) => string;
};

export const useSqlEditorTransactionController = ({
  tabId,
  translate,
}: UseSqlEditorTransactionControllerOptions) => {
  const setSqlEditorPendingTransaction = useStore(state => state.setSqlEditorPendingTransaction);
  const addSqlLog = useStore(state => state.addSqlLog);
  const [pendingSqlTransaction, setPendingSqlTransaction] = useState<PendingSqlEditorTransaction | null>(null);
  const pendingSqlTransactionRef = useRef<PendingSqlEditorTransaction | null>(null);
  const finishingTransactionIdsRef = useRef<Set<string>>(new Set());
  const autoCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCommitCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [autoCommitRemainingSeconds, setAutoCommitRemainingSeconds] = useState<number | null>(null);

  const translateMessage = useCallback((key: string, params?: TranslateParams) => {
    return translate ? translate(key, params) : catalogTranslate('zh-CN', key, params);
  }, [translate]);

  /**
   * 取事务所属连接。
   *
   * 用 getState 而不是订阅 connections：这里只在"提交前"按需读一次，
   * 订阅会让连接列表的任何变动都重渲染整个编辑器。
   *
   * 找不到时返回 null，调用方据此 fail-closed。
   * 不要把 null 转交给 confirmProductionRisk：它对 null 直接返回 true，
   * 会让"连接已被删除"这条路径静默绕过生产确认。
   */
  const resolveTransactionConnection = useCallback((connectionId?: string) => {
    const safeConnectionId = String(connectionId || '').trim();
    if (!safeConnectionId) return null;
    const stateConnections = useStore.getState().connections;
    return stateConnections.find(connection => connection.id === safeConnectionId) || null;
  }, []);

  const rawErrorDetail = useCallback((error: unknown) => {
    if (typeof error === 'string' && error.trim()) return error;
    if (error instanceof Error && error.message.trim()) return error.message;
    const messageValue = (error as any)?.message;
    if (typeof messageValue === 'string' && messageValue.trim()) return messageValue;
    if (error !== undefined && error !== null) return String(error);
    return translateMessage('common.unknown');
  }, [translateMessage]);

  const clearAutoCommitTimer = useCallback(() => {
    if (autoCommitTimerRef.current) {
      clearTimeout(autoCommitTimerRef.current);
      autoCommitTimerRef.current = null;
    }
    if (autoCommitCountdownRef.current) {
      clearInterval(autoCommitCountdownRef.current);
      autoCommitCountdownRef.current = null;
    }
    setAutoCommitRemainingSeconds(null);
  }, []);

  const updatePendingSqlTransaction = useCallback((transaction: PendingSqlEditorTransaction | null) => {
    pendingSqlTransactionRef.current = transaction;
    setPendingSqlTransaction(transaction);
    setSqlEditorPendingTransaction(tabId, transaction);
  }, [setSqlEditorPendingTransaction, tabId]);

  /**
   * 自动提交被生产确认拦下后，把事务退回手动模式。
   *
   * 不能只是"不提交"：此时数据库侧事务仍然打开，若不改状态，工具栏会继续显示
   * 自动提交倒计时，用户等到的却永远不是提交 —— 是个假的进行中状态。
   * 退回手动后倒计时清除、提交按钮可用，由用户显式决定。
   */
  const downgradeToManualTransaction = useCallback((transaction: PendingSqlEditorTransaction) => {
    if (pendingSqlTransactionRef.current?.id !== transaction.id) {
      return;
    }
    updatePendingSqlTransaction({
      ...transaction,
      commitMode: 'manual',
      autoCommitDelayMs: 0,
      autoCommitDueAt: null,
    });
  }, [updatePendingSqlTransaction]);

  const appendPendingSqlTransactionExecution = useCallback(({
    transactionId,
    statements,
    durationMs,
  }: {
    transactionId: string;
    statements: string[];
    durationMs: number;
  }) => {
    const transaction = pendingSqlTransactionRef.current;
    if (!transaction || transaction.id !== String(transactionId || '').trim()) {
      return;
    }
    const nextStatements = Array.isArray(statements)
      ? statements.map((statement) => String(statement || '').trim()).filter(Boolean)
      : [];
    updatePendingSqlTransaction({
      ...transaction,
      statements: [...(transaction.statements || []), ...nextStatements],
      statementCount: Math.max(0, Number(transaction.statementCount) || 0) + nextStatements.length,
      executionDurationMs: Math.max(0, Number(transaction.executionDurationMs) || 0)
        + Math.max(0, Number(durationMs) || 0),
    });
  }, [updatePendingSqlTransaction]);

  const addTransactionCompletionLog = useCallback(({
    transaction,
    action,
    status,
    finishDurationMs,
    detail,
  }: {
    transaction: PendingSqlEditorTransaction;
    action: FinishSqlEditorTransactionAction;
    status: 'success' | 'error';
    finishDurationMs: number;
    detail?: string;
  }) => {
    addSqlLog({
      id: `transaction-${transaction.id}-${Date.now()}`,
      timestamp: Date.now(),
      sql: buildSqlEditorTransactionLog({
        dbType: transaction.dbType,
        statements: transaction.statements,
        action,
      }),
      status,
      duration: Math.max(0, Number(transaction.executionDurationMs) || 0)
        + Math.max(0, Number(finishDurationMs) || 0),
      message: status === 'error' ? detail : undefined,
      dbName: transaction.dbName,
      category: 'transaction',
      transactionId: transaction.id,
      transactionAction: action,
    });
  }, [addSqlLog]);

  const finishPendingSqlTransaction = useCallback(async (
    action: FinishSqlEditorTransactionAction,
    source: FinishSqlEditorTransactionSource = 'manual',
    transactionId?: string,
  ) => {
    const transaction = pendingSqlTransactionRef.current;
    if (!transaction || (transactionId && transaction.id !== transactionId)) {
      return;
    }
    if (finishingTransactionIdsRef.current.has(transaction.id)) {
      return;
    }

    // 生产确认必须在任何状态变更之前完成：一旦先把本地事务状态清掉再被用户拒绝，
    // 数据库侧事务仍然打开并持有锁，而 UI 已没有提交/回滚入口，只能关标签页收尾。
    // 只门禁 commit —— rollback 是撤销操作，对它加门禁只会让用户更难从生产环境退出。
    if (action === 'commit') {
      const connection = resolveTransactionConnection(transaction.connectionId);
      // 连接查不到时 fail-closed，与 DataGrid 提交（DataGrid.tsx:3968）和 handleRun
      // 的 connection_not_found 分支一致。不能放进 confirmProductionRisk 走它的
      // null 分支 —— 那会直接返回 true，等于让"连接不可解析"绕过生产确认。
      if (!connection) {
        message.error(translateMessage('query_editor.message.connection_not_found'));
        return;
      }
      // 只有真正需要确认的连接才进入异步等待。不需要确认时保持"同步走到 RPC"的
      // 原有语义：否则自动提交与标签页关闭之间会多出一个微任务窗口，
      // 卸载清理可能对着一个正在提交的事务发出竞争性的 rollback。
      if (requiresProductionRiskConfirmation(connection)) {
        // 占住 finishing 标记，避免确认对话框期间重复点击弹出第二个对话框。
        // 卸载清理只看 pending 状态、不看本集合，因此标签页在确认期间关闭时
        // 仍会照常回滚 —— 用户没确认就离开，本就不该提交。
        finishingTransactionIdsRef.current.add(transaction.id);
        const releaseConfirmationClaim = () => {
          finishingTransactionIdsRef.current.delete(transaction.id);
        };
        const approved = await confirmProductionRisk({
          connection,
          action: translateMessage('connection.production_risk.action.commit_transaction'),
          target: [transaction.dbName, transaction.dbType].filter(Boolean).join(' / '),
          translate: translateMessage,
        });
        // 确认期间事务可能已被其它入口终结（标签页关闭、自动提交竞态）：
        // 重新取一次引用，避免对一个已经结束的事务继续发提交请求。
        if (pendingSqlTransactionRef.current?.id !== transaction.id) {
          releaseConfirmationClaim();
          return;
        }
        if (!approved) {
          releaseConfirmationClaim();
          // 自动提交被拒后降级为手动：否则倒计时继续跑，用户看到"自动提交中"
          // 的状态而实际不会提交，是一个假的进行中状态。
          if (source === 'auto') {
            downgradeToManualTransaction(transaction);
          }
          return;
        }
      }
    }

    clearAutoCommitTimer();
    finishingTransactionIdsRef.current.add(transaction.id);
    updatePendingSqlTransaction(null);
    const finishStartedAt = Date.now();
    try {
      const res = action === 'commit'
        ? await DBCommitTransactionWithTrigger(transaction.id, source)
        : await DBRollbackTransactionWithTrigger(transaction.id, source);
      if (res?.success) {
        addTransactionCompletionLog({
          transaction,
          action,
          status: 'success',
          finishDurationMs: Date.now() - finishStartedAt,
        });
        if (action === 'commit') {
          message.success(source === 'auto'
            ? translateMessage('data_grid.message.auto_commit_success')
            : translateMessage('data_grid.message.transaction_committed'));
        } else {
          message.success(translateMessage('data_grid.message.transaction_rolled_back'));
        }
        return;
      }
      const detail = rawErrorDetail(res?.message);
      const outcomeUnknown = res?.outcomeUnknown === true;
      const displayDetail = outcomeUnknown
        ? `${detail} (${translateMessage('data_grid.message.transaction_outcome_unknown')})`
        : detail;
      addTransactionCompletionLog({
        transaction,
        action,
        status: 'error',
        finishDurationMs: Date.now() - finishStartedAt,
        detail: displayDetail,
      });
      const key = source === 'auto'
        ? 'data_grid.message.auto_commit_failed'
        : action === 'commit'
          ? 'data_grid.message.commit_failed'
          : 'data_grid.message.rollback_failed';
      message.error(translateMessage(key, { detail: displayDetail }));
    } catch (err: any) {
      const detail = rawErrorDetail(err);
      addTransactionCompletionLog({
        transaction,
        action,
        status: 'error',
        finishDurationMs: Date.now() - finishStartedAt,
        detail,
      });
      const key = source === 'auto'
        ? 'data_grid.message.auto_commit_failed'
        : action === 'commit'
          ? 'data_grid.message.commit_failed'
          : 'data_grid.message.rollback_failed';
      message.error(translateMessage(key, { detail }));
    } finally {
      finishingTransactionIdsRef.current.delete(transaction.id);
    }
  }, [addTransactionCompletionLog, clearAutoCommitTimer, rawErrorDetail, translateMessage, updatePendingSqlTransaction]);

  const activatePendingSqlTransaction = useCallback((transaction: PendingSqlEditorTransaction) => {
    clearAutoCommitTimer();
    const autoCommitDelayMs = Math.max(0, Number(transaction.autoCommitDelayMs) || 0);
    const dueAt = transaction.commitMode === 'auto' ? Date.now() + autoCommitDelayMs : null;
    const statements = Array.isArray(transaction.statements)
      ? transaction.statements.map((statement) => String(statement || '').trim()).filter(Boolean)
      : [];
    const nextTransaction = {
      ...transaction,
      autoCommitDelayMs,
      autoCommitDueAt: dueAt,
      statements,
      executionDurationMs: Math.max(0, Number(transaction.executionDurationMs) || 0),
    };
    updatePendingSqlTransaction(nextTransaction);
    if (nextTransaction.commitMode !== 'auto' || !dueAt) {
      return;
    }
    if (autoCommitDelayMs === 0) {
      setAutoCommitRemainingSeconds(0);
      autoCommitTimerRef.current = setTimeout(() => {
        autoCommitTimerRef.current = null;
        setAutoCommitRemainingSeconds(null);
        void finishPendingSqlTransaction('commit', 'auto', nextTransaction.id);
      }, 0);
      return;
    }
    const updateRemaining = () => {
      setAutoCommitRemainingSeconds(Math.max(1, Math.ceil((dueAt - Date.now()) / 1000)));
    };
    updateRemaining();
    autoCommitCountdownRef.current = setInterval(updateRemaining, 250);
    autoCommitTimerRef.current = setTimeout(() => {
      autoCommitTimerRef.current = null;
      if (autoCommitCountdownRef.current) {
        clearInterval(autoCommitCountdownRef.current);
        autoCommitCountdownRef.current = null;
      }
      setAutoCommitRemainingSeconds(null);
      void finishPendingSqlTransaction('commit', 'auto', nextTransaction.id);
    }, autoCommitDelayMs);
  }, [clearAutoCommitTimer, finishPendingSqlTransaction, updatePendingSqlTransaction]);

  useEffect(() => {
    return () => {
      clearAutoCommitTimer();
      const transaction = pendingSqlTransactionRef.current;
      if (transaction?.id) {
        pendingSqlTransactionRef.current = null;
        setSqlEditorPendingTransaction(tabId, null);
        void DBRollbackTransactionWithTrigger(transaction.id, 'tab_close');
      }
    };
  }, [clearAutoCommitTimer, setSqlEditorPendingTransaction, tabId]);

  return {
    activatePendingSqlTransaction,
    appendPendingSqlTransactionExecution,
    autoCommitRemainingSeconds,
    finishPendingSqlTransaction,
    pendingSqlTransaction,
    pendingSqlTransactionRef,
  };
};
