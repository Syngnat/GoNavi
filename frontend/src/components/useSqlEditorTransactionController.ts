import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';

import { DBCommitTransactionWithTrigger, DBRollbackTransactionWithTrigger } from '../../wailsjs/go/app/App';
import { t as catalogTranslate } from '../i18n/catalog';
import { useStore } from '../store';
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
