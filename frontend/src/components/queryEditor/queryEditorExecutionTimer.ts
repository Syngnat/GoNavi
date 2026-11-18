import { useEffect, useRef, useState } from 'react';

import { formatQueryDuration } from '../../utils/queryDurationFormat';

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

/**
 * `awaitingDriverRef.current` 为 true 表示后端仍在建连（starting 阶段）：
 * 此时计时归零并重新起算，保证界面上跳动的数字与最终的驱动侧耗时口径一致。
 *
 * 计时口径统一为「墙钟」：从开始计到这一轮真正结束。**不要**在后端 RPC 返回时
 * 就停表并把后端 `durationMs` 塞进 `completedElapsedMs`——那个值是「驱动侧 SQL
 * 执行耗时，不含建连与结果回传」（connection/types.go:414），与用户看到的转圈
 * 时长不是一回事。混用会让数字在按钮停转的瞬间凭空跳变（例如 1.64s → 656ms）。
 */
export const useQueryExecutionElapsed = (
  timingActive: boolean,
  executionRunToken = 0,
  completedElapsedMs: number | null = null,
  awaitingDriverRef?: { current: boolean },
): number => {
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const lastTokenRef = useRef(executionRunToken);

  useEffect(() => {
    const tokenChanged = lastTokenRef.current !== executionRunToken;
    lastTokenRef.current = executionRunToken;

    if (tokenChanged) {
      // 新一轮执行必须从 0 起算，不能沿用上一轮的开始时间。
      startedAtRef.current = timingActive ? Date.now() : null;
      setElapsedMs(0);
      if (!timingActive) return;
    }

    if (!timingActive) {
      const startedAt = startedAtRef.current;
      startedAtRef.current = null;
      if (typeof completedElapsedMs === "number" && Number.isFinite(completedElapsedMs) && completedElapsedMs >= 0) {
        setElapsedMs(Math.round(completedElapsedMs));
        return;
      }
      if (startedAt !== null) {
        setElapsedMs(Date.now() - startedAt);
      }
      return;
    }

    // 已有开始时间时保留它：`timingActive` 会因为 loading/状态变化重跑本 effect，
    // 每次重置 startedAt 会让显示的时间永远停在接近 0 的位置。
    let startedAt = startedAtRef.current ?? Date.now();
    startedAtRef.current = startedAt;
    const updateElapsed = () => {
      if (awaitingDriverRef?.current && startedAtRef.current !== startedAt) {
        startedAt = startedAtRef.current as number;
      }
      setElapsedMs(Date.now() - startedAt);
    };
    updateElapsed();
    const timer = globalThis.setInterval(updateElapsed, QUERY_EXECUTION_TIMER_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [awaitingDriverRef, completedElapsedMs, executionRunToken, timingActive]);

  return elapsedMs;
};
