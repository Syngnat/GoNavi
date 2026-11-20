import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  ScriptOutputPage,
  ScriptRunObserver,
  ScriptRunRequest,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import {
  initialScriptRunSessionState,
  scriptRunSessionReducer,
} from './scriptRunSessionState';
import { ScriptWorkbenchRequestError } from './scriptWorkbenchErrors';
import { withScriptWorkbenchTimeout } from './scriptWorkbenchRequestAbort';

const START_TIMEOUT_MS = 31_000;
const CANCEL_TIMEOUT_MS = 11_000;

export const useScriptRunSession = (
  adapter: ScriptWorkbenchAdapter,
  onOutputPageError?: (message: string) => void,
  formatError?: (error: unknown) => string,
) => {
  const [state, dispatch] = useReducer(scriptRunSessionReducer, initialScriptRunSessionState);
  const [pageLoading, setPageLoading] = useState(false);
  const runIdRef = useRef('');
  const generationRef = useRef(0);
  const startInFlightRef = useRef(false);
  const pendingCancelRef = useRef(false);
  const startAbortRef = useRef<AbortController | null>(null);
  const pageRequestRef = useRef(0);
  const pageAbortRef = useRef<AbortController | null>(null);
  const formatErrorRef = useRef(formatError);
  formatErrorRef.current = formatError;

  const errorMessage = useCallback((error: unknown): string => (
    formatErrorRef.current?.(error)
    ?? (error instanceof Error ? error.message : String(error))
  ), []);

  const dispatchOutcomeUnknown = useCallback((startedAt: number) => {
    dispatch({
      type: 'event',
      event: {
        type: 'result',
        result: {
          success: false,
          outcomeUnknown: true,
          message: formatErrorRef.current?.(
            new ScriptWorkbenchRequestError(
              'Script outcome is unknown',
              'outcome_unknown',
            ),
          ) || 'script_workbench.error.outcome_unknown',
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      },
    });
  }, []);

  const start = useCallback(async (request: ScriptRunRequest) => {
    if (startInFlightRef.current) return null;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    startInFlightRef.current = true;
    pendingCancelRef.current = false;
    runIdRef.current = '';
    const startedAt = Date.now();
    const startController = new AbortController();
    startAbortRef.current?.abort();
    startAbortRef.current = startController;
    dispatch({ type: 'preparing' });
    const observer: ScriptRunObserver = {
      onEvent: (event) => {
        if (generation === generationRef.current) {
          dispatch({ type: 'event', event });
        }
      },
    };
    try {
      const receipt = await withScriptWorkbenchTimeout(
        adapter.runScript(request, observer, startController.signal),
        START_TIMEOUT_MS,
        'Script start timed out',
        'outcome_unknown',
      );
      if (generation !== generationRef.current) {
        // A reset/tab switch happened while the start RPC was in flight. The
        // server may already own a worker, so cancel it before dropping it.
        void adapter.cancelRun(receipt.runId).catch(() => undefined);
        return null;
      }
      runIdRef.current = receipt.runId;
      if (pendingCancelRef.current) {
        pendingCancelRef.current = false;
        dispatch({ type: 'cancelling' });
        try {
          await withScriptWorkbenchTimeout(
            adapter.cancelRun(receipt.runId),
            CANCEL_TIMEOUT_MS,
            'Script cancellation timed out',
            'outcome_unknown',
          );
        } catch (cancelError) {
          if (
            cancelError instanceof ScriptWorkbenchRequestError
            && cancelError.code === 'outcome_unknown'
          ) {
            runIdRef.current = '';
            dispatchOutcomeUnknown(startedAt);
            return null;
          }
          throw cancelError;
        }
      }
      return receipt;
    } catch (runError) {
      if (generation !== generationRef.current) return null;
      if (pendingCancelRef.current) {
        pendingCancelRef.current = false;
        dispatch({
          type: 'event',
          event: {
            type: 'result',
            result: { success: false, cancelled: true, durationMs: 0 },
          },
        });
        return null;
      }
      if (
        runError instanceof ScriptWorkbenchRequestError
        && runError.code === 'outcome_unknown'
      ) {
        startController.abort();
        dispatchOutcomeUnknown(startedAt);
        return null;
      }
      dispatch({ type: 'failure', message: errorMessage(runError) });
      return null;
    } finally {
      if (startAbortRef.current === startController) {
        startAbortRef.current = null;
      }
      if (generation === generationRef.current) {
        startInFlightRef.current = false;
      }
    }
  }, [adapter, dispatchOutcomeUnknown, errorMessage]);

  const cancel = useCallback(async () => {
    if (!runIdRef.current && !startInFlightRef.current) return;
    pendingCancelRef.current = true;
    dispatch({ type: 'cancelling' });
    if (!runIdRef.current) return;
    const startedAt = Date.now();
    try {
      await withScriptWorkbenchTimeout(
        adapter.cancelRun(runIdRef.current),
        CANCEL_TIMEOUT_MS,
        'Script cancellation timed out',
        'outcome_unknown',
      );
    } catch (cancelError) {
      if (
        cancelError instanceof ScriptWorkbenchRequestError
        && cancelError.code === 'outcome_unknown'
      ) {
        runIdRef.current = '';
        dispatchOutcomeUnknown(startedAt);
        return;
      }
      dispatch({ type: 'failure', message: errorMessage(cancelError) });
    }
  }, [adapter, dispatchOutcomeUnknown, errorMessage]);

  const loadOutputPage = useCallback(async (
    outputId: string,
    page: number,
    pageSize: number,
  ): Promise<ScriptOutputPage | null> => {
    const output = state.outputs.find((candidate) => candidate.outputId === outputId);
    if (!output) return null;
    const requestId = pageRequestRef.current + 1;
    pageRequestRef.current = requestId;
    pageAbortRef.current?.abort();
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    pageAbortRef.current = controller;
    setPageLoading(true);
    try {
      const next = await adapter.getOutputPage(output.outputId, page, pageSize, controller?.signal);
      if (requestId !== pageRequestRef.current || controller?.signal.aborted) return null;
      dispatch({ type: 'output', output: next });
      return next;
    } catch (pageError) {
      if (requestId === pageRequestRef.current && !controller?.signal.aborted) {
        onOutputPageError?.(errorMessage(pageError));
      }
      return null;
    } finally {
      if (requestId === pageRequestRef.current) {
        pageAbortRef.current = null;
        setPageLoading(false);
      }
    }
  }, [adapter, errorMessage, onOutputPageError, state.outputs]);

  const selectOutput = useCallback((outputId: string) => {
    pageAbortRef.current?.abort();
    pageAbortRef.current = null;
    pageRequestRef.current += 1;
    setPageLoading(false);
    dispatch({ type: 'select-output', outputId });
  }, []);

  const reset = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    startInFlightRef.current = false;
    pendingCancelRef.current = false;
    startAbortRef.current?.abort();
    startAbortRef.current = null;
    const runId = runIdRef.current;
    runIdRef.current = '';
    pageAbortRef.current?.abort();
    pageAbortRef.current = null;
    pageRequestRef.current += 1;
    setPageLoading(false);
    dispatch({ type: 'reset' });
    if (runId) {
      void withScriptWorkbenchTimeout(
        adapter.cancelRun(runId),
        CANCEL_TIMEOUT_MS,
        'Script cancellation timed out',
        'outcome_unknown',
      ).catch(() => undefined);
    }
  }, [adapter]);

  useEffect(() => () => {
    generationRef.current += 1;
    startAbortRef.current?.abort();
    startAbortRef.current = null;
    pageAbortRef.current?.abort();
    const runId = runIdRef.current;
    runIdRef.current = '';
    if (runId) {
      void withScriptWorkbenchTimeout(
        adapter.cancelRun(runId),
        CANCEL_TIMEOUT_MS,
        'Script cancellation timed out',
        'outcome_unknown',
      ).catch(() => undefined);
    }
  }, [adapter]);

  const output = state.outputs.find((candidate) => candidate.outputId === state.selectedOutputId)
    || state.outputs[0]
    || null;

  return {
    ...state,
    output,
    pageLoading,
    start,
    cancel,
    loadOutputPage,
    selectOutput,
    reset,
  };
};
