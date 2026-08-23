import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';

import { EventsOn } from '../../wailsjs/runtime/runtime';
import { t } from '../i18n';
import { calculateImportTransferMetrics } from './importProgressMetrics';

export type SQLFileExecutionProgressEvent = {
  jobId: string;
  status?: 'running' | 'done' | 'cancelled' | 'error';
  executed?: number;
  failed?: number;
  total?: number;
  percent?: number;
  bytesRead?: number;
  totalBytes?: number;
  stage?: string;
  currentSQL?: string;
  error?: string;
};

export type SQLFileExecutionRunnerStatus =
  | 'idle'
  | 'start'
  | 'running'
  | 'stopping'
  | 'done'
  | 'cancelled'
  | 'error';

export type SQLFileExecutionState = {
  jobId: string;
  title: string;
  filePath: string;
  fileSizeMB: string;
  startedAt: number;
  finishedAt: number;
  status: SQLFileExecutionRunnerStatus;
  stage: string;
  executed: number;
  failed: number;
  total: number;
  percent: number;
  bytesRead: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSeconds: number;
  currentSQL: string;
  message: string;
};

export type SQLFileExecutionRunResult = {
  success: boolean;
  message: string;
  data?: unknown;
};

export type RunSQLFileExecutionWithProgressOptions<T extends SQLFileExecutionRunResult> = {
  title: string;
  filePath: string;
  fileSizeMB?: string;
  run: (jobId: string) => Promise<T>;
  cancel?: (jobId: string) => void | Promise<void>;
};

type UseSQLFileExecutionRunnerOptions = {
  showToast?: boolean;
};

const createInitialState = (): SQLFileExecutionState => ({
  jobId: '',
  title: '',
  filePath: '',
  fileSizeMB: '',
  startedAt: 0,
  finishedAt: 0,
  status: 'idle',
  stage: '',
  executed: 0,
  failed: 0,
  total: 0,
  percent: 0,
  bytesRead: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  etaSeconds: 0,
  currentSQL: '',
  message: '',
});

const normalizeCount = (value: unknown): number => {
  const next = Number(value);
  if (!Number.isFinite(next) || next < 0) {
    return 0;
  }
  return Math.trunc(next);
};

const buildSQLFileExecutionJobId = (): string =>
  `sql-file-execution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const EXECUTION_CANCELED_MESSAGE = '\u5df2\u53d6\u6d88';

const isStructuredCancelledResult = (result: SQLFileExecutionRunResult): boolean => {
  const data = result?.data;
  return Boolean(data && typeof data === 'object' && (data as { cancelled?: unknown }).cancelled === true);
};

export function useSQLFileExecutionRunner(options?: UseSQLFileExecutionRunnerOptions) {
  const showToast = options?.showToast !== false;
  const [state, setState] = useState<SQLFileExecutionState>(() => createInitialState());
  const [rpcInFlight, setRPCInFlight] = useState(false);
  const activeJobIdRef = useRef('');
  const runningJobIdRef = useRef('');
  const pendingEventRef = useRef<SQLFileExecutionProgressEvent | null>(null);
  const flushFrameRef = useRef<number | null>(null);
  const cancelRequestedJobIdRef = useRef('');
  const cancelHandlerRef = useRef<{
    jobId: string;
    handler: (jobId: string) => void | Promise<void>;
  } | null>(null);

  useEffect(() => {
    const flushPendingEvent = () => {
      flushFrameRef.current = null;
      const event = pendingEventRef.current;
      pendingEventRef.current = null;
      if (!event || String(event.jobId || '') !== activeJobIdRef.current) {
        return;
      }

      setState((prev) => {
        if (prev.jobId !== activeJobIdRef.current) {
          return prev;
        }
        const reportedStatus = (event.status || prev.status || 'running') as SQLFileExecutionRunnerStatus;
        const wasTerminal = prev.status === 'done' || prev.status === 'cancelled' || prev.status === 'error';
        const reportedIsTerminal = reportedStatus === 'done' || reportedStatus === 'cancelled' || reportedStatus === 'error';
        if (wasTerminal && !reportedIsTerminal) {
          return prev;
        }
        // The RPC result is authoritative once it has settled. A terminal
        // progress event delayed by the animation-frame throttle may still
        // contribute final counters/percent, but must not rewrite that result.
        const nextStatus = wasTerminal && reportedIsTerminal
          ? prev.status
          : prev.status === 'stopping' && !reportedIsTerminal
            ? 'stopping'
            : reportedStatus;
        const nextStartedAt = prev.startedAt || Date.now();
        const isTerminal = nextStatus === 'done' || nextStatus === 'cancelled' || nextStatus === 'error';
        const reportedPercent = Math.max(0, Math.min(100, Number(event.percent ?? prev.percent) || 0));
        const nextPercent = reportedStatus === 'done' || nextStatus === 'done'
          ? 100
          : Math.min(99, reportedPercent);
        const nextBytesRead = normalizeCount(event.bytesRead ?? prev.bytesRead);
        const nextTotalBytes = normalizeCount(event.totalBytes ?? prev.totalBytes);
        const transferMetrics = calculateImportTransferMetrics({
          startedAt: nextStartedAt,
          now: Date.now(),
          bytesRead: nextBytesRead,
          totalBytes: nextTotalBytes,
        });
        const preserveSettledMessage = wasTerminal
          && reportedIsTerminal
          && typeof prev.message === 'string'
          && Boolean(prev.message.trim());
        return {
          ...prev,
          startedAt: nextStartedAt,
          finishedAt: isTerminal ? (prev.finishedAt || Date.now()) : prev.finishedAt,
          status: nextStatus,
          stage: nextStatus === 'stopping'
            ? t('sidebar.sql_file_exec.status.stopping')
            : typeof event.stage === 'string' && event.stage.trim() && !isTerminal
            ? event.stage.trim()
            : nextStatus === 'cancelled'
              ? t('sidebar.sql_file_exec.status.cancelled')
              : nextStatus === 'error'
                ? t('sidebar.sql_file_exec.status.error')
                : nextStatus === 'done'
                  ? t('sidebar.sql_file_exec.status.done')
                  : t('sidebar.sql_file_exec.status.running'),
          executed: normalizeCount(event.executed ?? prev.executed),
          failed: normalizeCount(event.failed ?? prev.failed),
          total: normalizeCount(event.total ?? prev.total),
          percent: nextPercent,
          bytesRead: nextBytesRead,
          totalBytes: nextTotalBytes,
          bytesPerSecond: transferMetrics.bytesPerSecond,
          etaSeconds: transferMetrics.etaSeconds,
          currentSQL: typeof event.currentSQL === 'string' ? event.currentSQL : prev.currentSQL,
          message: preserveSettledMessage
            ? prev.message
            : typeof event.error === 'string' && event.error.trim()
              ? event.error
              : prev.message,
        };
      });
    };

    const scheduleFlush = () => {
      if (flushFrameRef.current !== null) {
        return;
      }
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        flushFrameRef.current = window.requestAnimationFrame(flushPendingEvent);
        return;
      }
      flushFrameRef.current = globalThis.setTimeout(flushPendingEvent, 16) as unknown as number;
    };

    const off = EventsOn('sqlfile:progress', (event: SQLFileExecutionProgressEvent) => {
      if (!event || String(event.jobId || '') !== activeJobIdRef.current) {
        return;
      }
      pendingEventRef.current = event;
      scheduleFlush();
    });

    return () => {
      if (flushFrameRef.current !== null) {
        if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(flushFrameRef.current);
        } else {
          globalThis.clearTimeout(flushFrameRef.current);
        }
        flushFrameRef.current = null;
      }
      pendingEventRef.current = null;
      if (typeof off === 'function') {
        off();
      }
    };
  }, []);

  const reset = useCallback(() => {
    if (runningJobIdRef.current) {
      return;
    }
    activeJobIdRef.current = '';
    runningJobIdRef.current = '';
    pendingEventRef.current = null;
    cancelRequestedJobIdRef.current = '';
    cancelHandlerRef.current = null;
    setState(createInitialState());
  }, []);

  const cancelExecution = useCallback(async () => {
    const jobId = activeJobIdRef.current;
    const cancelRegistration = cancelHandlerRef.current;
    if (!jobId || !cancelRegistration || cancelRegistration.jobId !== jobId) {
      return;
    }
    if (cancelRequestedJobIdRef.current === jobId) {
      return;
    }
    cancelRequestedJobIdRef.current = jobId;
    try {
      await cancelRegistration.handler(jobId);
    } catch (error: any) {
      if (cancelRequestedJobIdRef.current === jobId) {
        cancelRequestedJobIdRef.current = '';
      }
      if (showToast) {
        void message.error(error?.message || String(error));
      }
      throw error;
    }
    setState((prev) => (
      prev.jobId !== jobId
        || prev.status === 'done'
        || prev.status === 'cancelled'
        || prev.status === 'error'
        ? prev
        : {
            ...prev,
            status: 'stopping',
            stage: t('sidebar.sql_file_exec.status.stopping'),
          }
    ));
  }, [showToast]);

  const runSQLFileExecutionWithProgress = useCallback(async <T extends SQLFileExecutionRunResult,>(
    runOptions: RunSQLFileExecutionWithProgressOptions<T>,
  ): Promise<T | null> => {
    if (runningJobIdRef.current) {
      if (showToast) {
        void message.warning(t('sidebar.sql_file_exec.message.already_running'));
      }
      return null;
    }

    const jobId = buildSQLFileExecutionJobId();
    runningJobIdRef.current = jobId;
    setRPCInFlight(true);
    activeJobIdRef.current = jobId;
    cancelRequestedJobIdRef.current = '';
    cancelHandlerRef.current = runOptions.cancel
      ? { jobId, handler: runOptions.cancel }
      : null;
    setState({
      jobId,
      title: String(runOptions.title || '').trim(),
      filePath: String(runOptions.filePath || '').trim(),
      fileSizeMB: String(runOptions.fileSizeMB || '').trim(),
      startedAt: 0,
      finishedAt: 0,
      status: 'start',
      stage: t('sidebar.sql_file_exec.workbench.stage.preparing'),
      executed: 0,
      failed: 0,
      total: 0,
      percent: 0,
      bytesRead: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      etaSeconds: 0,
      currentSQL: '',
      message: '',
    });

    try {
      const result = await runOptions.run(jobId);
      setState((prev) => {
        if (prev.jobId !== jobId) {
          return prev;
        }
        const canceled = prev.status === 'cancelled'
          || isStructuredCancelledResult(result)
          || result.message === EXECUTION_CANCELED_MESSAGE;
        const nextStatus: SQLFileExecutionRunnerStatus = canceled
          ? 'cancelled'
          : result.success
            ? 'done'
            : 'error';
        return {
          ...prev,
          startedAt: prev.startedAt || Date.now(),
          finishedAt: prev.finishedAt || Date.now(),
          status: nextStatus,
          stage: nextStatus === 'cancelled'
            ? t('sidebar.sql_file_exec.status.cancelled')
            : nextStatus === 'done'
              ? t('sidebar.sql_file_exec.status.done')
              : t('sidebar.sql_file_exec.status.error'),
          percent: nextStatus === 'done' || prev.status === 'done'
            ? 100
            : Math.min(99, prev.percent),
          message: typeof result.message === 'string' ? result.message : prev.message,
        };
      });

      if (showToast) {
        if (isStructuredCancelledResult(result) || result.message === EXECUTION_CANCELED_MESSAGE) {
          void message.info(t('sidebar.sql_file_exec.status.cancelled'));
        } else if (result.success) {
          void message.success(t('sidebar.sql_file_exec.status.done'));
        } else {
          void message.error(result.message || t('sidebar.sql_file_exec.status.error'));
        }
      }
      return result;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      setState((prev) => {
        if (prev.jobId !== jobId) {
          return prev;
        }
        return {
          ...prev,
          startedAt: prev.startedAt || Date.now(),
          finishedAt: prev.finishedAt || Date.now(),
          status: prev.status === 'cancelled' || errorMessage === EXECUTION_CANCELED_MESSAGE ? 'cancelled' : 'error',
          stage: prev.status === 'cancelled' || errorMessage === EXECUTION_CANCELED_MESSAGE
            ? t('sidebar.sql_file_exec.status.cancelled')
            : t('sidebar.sql_file_exec.status.error'),
          message: errorMessage,
        };
      });
      if (showToast) {
        if (errorMessage === EXECUTION_CANCELED_MESSAGE) {
          void message.info(t('sidebar.sql_file_exec.status.cancelled'));
        } else {
          void message.error(errorMessage);
        }
      }
      throw error;
    } finally {
      if (runningJobIdRef.current === jobId) {
        runningJobIdRef.current = '';
        setRPCInFlight(false);
      }
      if (cancelRequestedJobIdRef.current === jobId) {
        cancelRequestedJobIdRef.current = '';
      }
      if (cancelHandlerRef.current?.jobId === jobId) {
        cancelHandlerRef.current = null;
      }
    }
  }, [showToast]);

  return {
    state,
    reset,
    cancelExecution,
    runSQLFileExecutionWithProgress,
    isRunning: rpcInFlight
      || state.status === 'start'
      || state.status === 'running'
      || state.status === 'stopping',
  };
}
