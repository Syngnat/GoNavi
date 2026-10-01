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

    if (tokenChanged && !timingActive) {
      startedAtRef.current = null;
      setElapsedMs(0);
      return;
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

    let startedAt = Date.now();
    startedAtRef.current = startedAt;
    setElapsedMs(0);
    const updateElapsed = () => {
      if (awaitingDriverRef?.current) {
        startedAt = Date.now();
        startedAtRef.current = startedAt;
      }
      setElapsedMs(Date.now() - startedAt);
    };
    updateElapsed();
    const timer = globalThis.setInterval(updateElapsed, QUERY_EXECUTION_TIMER_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [awaitingDriverRef, completedElapsedMs, executionRunToken, timingActive]);

  return elapsedMs;
};
