import { useEffect, useRef, useState } from 'react';

import { formatQueryDuration } from '../../utils/queryDurationFormat';
import {
  isQueryEditorAwaitingDriver,
  isTerminalQueryEditorExecutionStatus,
  type QueryEditorExecutionLifecycleState,
} from './queryEditorExecutionLifecycle';

const QUERY_EXECUTION_TIMER_INTERVAL_MS = 100;

export const formatQueryExecutionElapsed = formatQueryDuration;

export const resolveReportedQueryDurationMs = (
  result: { durationMs?: unknown } | null | undefined,
  fallbackMs: number,
): number => {
  const reported = result?.durationMs;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return Math.round(reported);
  }
  return Math.max(0, Math.round(Number(fallbackMs) || 0));
};

export const resolveQueryExecutionSpeedIcon = (elapsedMs: number): "⚡" | "🐇" | "🐢" => {
  const normalizedElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  if (normalizedElapsedMs < 1_000) return "⚡";
  if (normalizedElapsedMs < 5_000) return "🐇";
  return "🐢";
};

export interface QueryExecutionTimerLifecycleHint {
  awaitingDriver: boolean;
  frozenDurationMs: number | null;
  backendExecuting: boolean;
  backendElapsedMs: number;
  hasBackendEvent: boolean;
  terminalWithoutDuration?: boolean;
}

export const resolveQueryExecutionLifecycleTimerHint = (
  lifecycle: QueryEditorExecutionLifecycleState | null | undefined,
): QueryExecutionTimerLifecycleHint => {
  if (!lifecycle || lifecycle.status === 'idle') {
    return {
      awaitingDriver: false,
      frozenDurationMs: null,
      backendExecuting: false,
      backendElapsedMs: 0,
      hasBackendEvent: false,
    };
  }
  if (isQueryEditorAwaitingDriver(lifecycle)) {
    return {
      awaitingDriver: true,
      frozenDurationMs: null,
      backendExecuting: false,
      backendElapsedMs: Math.max(0, Math.round(Number(lifecycle.elapsedMs) || 0)),
      hasBackendEvent: true,
    };
  }
  if (isTerminalQueryEditorExecutionStatus(lifecycle.status)) {
    const frozenDurationMs = lifecycle.hasDurationMs && lifecycle.durationMs !== null
      ? Math.max(0, Math.round(lifecycle.durationMs))
      : lifecycle.elapsedMs > 0
        ? Math.round(lifecycle.elapsedMs)
        : null;
    return {
      awaitingDriver: false,
      frozenDurationMs,
      backendExecuting: false,
      backendElapsedMs: frozenDurationMs ?? 0,
      hasBackendEvent: true,
      terminalWithoutDuration: frozenDurationMs === null,
    };
  }
  return {
    awaitingDriver: false,
    frozenDurationMs: null,
    backendExecuting: lifecycle.stage === 'executing',
    backendElapsedMs: Math.max(0, Math.round(Number(lifecycle.elapsedMs) || 0)),
    hasBackendEvent: true,
  };
};

export const shouldShowQueryExecutionElapsed = ({
  loading,
  timingActive,
  completedElapsedMs,
  elapsedMs,
  lifecycleHint,
  awaitBackendEvents,
}: {
  loading: boolean;
  timingActive: boolean;
  completedElapsedMs: number | null;
  elapsedMs: number;
  lifecycleHint: QueryExecutionTimerLifecycleHint;
  awaitBackendEvents: boolean;
}): boolean => {
  if (!loading) {
    return completedElapsedMs !== null;
  }
  if (lifecycleHint.frozenDurationMs !== null || completedElapsedMs !== null) {
    return true;
  }
  if (!timingActive) {
    return false;
  }
  if (lifecycleHint.awaitingDriver || lifecycleHint.terminalWithoutDuration) {
    return false;
  }
  if (lifecycleHint.hasBackendEvent) {
    return true;
  }
  // 无后端进度事件的通道（如 ES 控制台）立即展示；有进度事件的通道在首个事件前留 200ms 缓冲，避免冷建连时闪出 0ms。
  return !awaitBackendEvents || elapsedMs >= 200;
};

/**
 * 实时与完成态统一使用纯 SQL 执行耗时口径：
 * - 建连/重连等待（`awaitingDriver`）暂停计时；
 * - 后端 `executing` 阶段对齐后端纯 SQL 起点并按 100ms 跳动；
 * - 后端发出带 `durationMs` 的终态事件后立即定格（`frozenDurationMs`），不计入编码与结果回传耗时。
 */
export const useQueryExecutionElapsed = (
  timingActive: boolean,
  executionRunToken = 0,
  completedElapsedMs: number | null = null,
  lifecycleHint?: QueryExecutionTimerLifecycleHint,
): number => {
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const anchoredBackendExecutingRef = useRef(false);
  const lastTokenRef = useRef(executionRunToken);

  const awaitingDriver = lifecycleHint?.awaitingDriver === true;
  const frozenDurationMs = lifecycleHint?.frozenDurationMs ?? null;
  const backendExecuting = lifecycleHint?.backendExecuting === true;
  const backendElapsedMs = Math.max(0, Math.round(Number(lifecycleHint?.backendElapsedMs) || 0));
  const terminalWithoutDuration = lifecycleHint?.terminalWithoutDuration === true;

  useEffect(() => {
    const tokenChanged = lastTokenRef.current !== executionRunToken;
    lastTokenRef.current = executionRunToken;

    if (tokenChanged) {
      // 新一轮执行必须从 0 起算，不能沿用上一轮的开始时间。
      startedAtRef.current = null;
      anchoredBackendExecutingRef.current = false;
      setElapsedMs(0);
      if (!timingActive) return;
    }

    if (frozenDurationMs !== null) {
      startedAtRef.current = null;
      anchoredBackendExecutingRef.current = false;
      setElapsedMs(frozenDurationMs);
      return;
    }

    if (!timingActive) {
      const startedAt = startedAtRef.current;
      startedAtRef.current = null;
      anchoredBackendExecutingRef.current = false;
      if (typeof completedElapsedMs === "number" && Number.isFinite(completedElapsedMs) && completedElapsedMs >= 0) {
        setElapsedMs(Math.round(completedElapsedMs));
        return;
      }
      if (startedAt !== null) {
        setElapsedMs(Math.max(0, Date.now() - startedAt));
      }
      return;
    }

    if (awaitingDriver || terminalWithoutDuration) {
      startedAtRef.current = null;
      anchoredBackendExecutingRef.current = false;
      setElapsedMs(backendElapsedMs);
      return;
    }

    // 已有开始时间时保留它：`timingActive` 或生命周期状态刷新会重跑本 effect，
    // 只有首次收到后端 executing 时把起点对齐到后端纯 SQL 起始时刻。
    if (backendExecuting && !anchoredBackendExecutingRef.current) {
      anchoredBackendExecutingRef.current = true;
      startedAtRef.current = Date.now() - backendElapsedMs;
    } else if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }

    const startedAt = startedAtRef.current;
    const updateElapsed = () => {
      setElapsedMs(Math.max(0, Date.now() - startedAt));
    };
    updateElapsed();
    const timer = globalThis.setInterval(updateElapsed, QUERY_EXECUTION_TIMER_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [
    awaitingDriver,
    backendElapsedMs,
    backendExecuting,
    completedElapsedMs,
    executionRunToken,
    frozenDurationMs,
    terminalWithoutDuration,
    timingActive,
  ]);

  return elapsedMs;
};
