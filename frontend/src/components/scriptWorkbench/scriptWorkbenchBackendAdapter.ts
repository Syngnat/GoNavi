import type {
  DeleteScriptInput,
  SaveScriptFolderInput,
  SaveScriptInput,
  ScriptAuditEntry,
  ScriptConnectionBinding,
  ScriptInputBinding,
  ScriptLibraryFolder,
  ScriptLibraryScript,
  ScriptLibrarySnapshot,
  ScriptRunEvent,
  ScriptRunObserver,
  ScriptRunReceipt,
  ScriptRunRequest,
  ScriptWriteAuthorization,
  ScriptWriteAuthorizationRequest,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import {
  SCRIPT_MAX_LOG_ENTRIES,
  SCRIPT_MAX_OUTPUT_STREAMS,
} from './scriptWorkbenchTypes';
import {
  isWebRuntime,
  uploadBrowserFile,
} from '../../utils/browserFileTransfer';
import { BACKEND_CANCELLED_MESSAGE } from '../../utils/connectionExport';
import { invokeAppMethodDynamic, invokeAppWithSignal } from '../../utils/webRpc';
import {
  ScriptWorkbenchRequestError,
  formatScriptWorkbenchError,
  formatScriptRunErrorMessage,
  formatScriptRunStageMessage,
  isTransientScriptWorkbenchError,
} from './scriptWorkbenchErrors';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import { normalizeScriptAlias } from './scriptWorkbenchValidation';
import { scriptSourceHash } from './scriptWorkbenchUtils';
import { pickBrowserInputFile } from './scriptWorkbenchBrowserInput';
import {
  createTimedAbortSignal,
  withScriptWorkbenchTimeout,
} from './scriptWorkbenchRequestAbort';
import type {
  BackendAuditPage,
  BackendOutputPage,
  BackendRunSnapshot,
  BackendScript,
  BackendSnapshot,
  BackendWriteAuthorization,
  QueryResult,
} from './scriptWorkbenchBackendTypes';
import {
  mapOutputPage,
  normalizeFolder,
  normalizeScript,
  normalizeSnapshot,
} from './scriptWorkbenchBackendMapping';

interface RunTracker {
  observer: ScriptRunObserver;
  connections: ScriptConnectionBinding[];
  startedAt: number;
  seenLogKeys: Set<string>;
  outputCount: number;
  outputFailures: number;
  pollFailures: number;
  nextOutputRetryAt: number;
  finished: boolean;
  polling: boolean;
  timer: number | null;
}

const APP_NAMESPACE = 'app';
const APP_SERVICE = 'App';
const POLL_INTERVAL_MS = 400;
const MAX_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_FAILURES = 5;
const START_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 15_000;
const OUTPUT_TIMEOUT_MS = 15_000;

const appMethods = (): Record<string, (...args: unknown[]) => Promise<unknown>> => {
  if (typeof window === 'undefined') return {};
  const bridge = (window as any).go?.[APP_NAMESPACE]?.[APP_SERVICE];
  return bridge && typeof bridge === 'object' ? bridge : {};
};

const requireAppMethod = (name: string): ((...args: unknown[]) => Promise<unknown>) => {
  const method = appMethods()[name];
  if (typeof method !== 'function') {
    throw new ScriptWorkbenchRequestError(
      `Script workbench backend method unavailable: ${name}`,
      'backend_unavailable',
    );
  }
  return method;
};

const callRaw = async <T>(name: string, ...args: unknown[]): Promise<QueryResult<T>> => {
  const webResult = invokeAppMethodDynamic<QueryResult<T>>(name, args);
  if (webResult) return await webResult;
  const result = await requireAppMethod(name)(...args) as QueryResult<T> | null;
  return result || { success: false, message: `${name} returned no result` };
};

const callRawWithSignal = async <T>(
  name: string,
  args: unknown[],
  signal: AbortSignal | undefined,
): Promise<QueryResult<T>> => {
  if (!signal) {
    const webResult = invokeAppMethodDynamic<QueryResult<T>>(name, args);
    if (webResult) return await webResult;
  }
  const fallback = () => requireAppMethod(name)(...args) as Promise<QueryResult<T>>;
  const result = signal
    ? await invokeAppWithSignal<QueryResult<T>>(name, args, signal, fallback)
    : await fallback();
  return result || { success: false, message: `${name} returned no result` };
};

const throwBackendFailure = <T>(
  name: string,
  result: QueryResult<T>,
  t: ScriptWorkbenchTranslate,
): T => {
  if (result.success === false) {
    const message = String(result.message || '').trim() || `${name} failed`;
    throw new ScriptWorkbenchRequestError(
      formatScriptWorkbenchError({
        message,
        code: result.code,
        params: result.params,
        kind: result.kind,
      }, t),
      result.code,
      result.params,
      result.kind,
    );
  }
  return result.data as T;
};

const call = async <T>(
  name: string,
  t: ScriptWorkbenchTranslate,
  ...args: unknown[]
): Promise<T> => {
  const result = await callRaw<T>(name, ...args);
  return throwBackendFailure(name, result, t);
};

const filenameFromPath = (path: string): string => (
  path.split(/[\\/]/).filter(Boolean).pop() || path
);

const stemFromFilename = (name: string): string => normalizeScriptAlias(
  name.replace(/\.[^.]+$/, ''),
  'input',
);

export const createScriptWorkbenchBackendAdapter = (
  t: ScriptWorkbenchTranslate,
): ScriptWorkbenchAdapter => {
  let snapshotCache = normalizeSnapshot(null);
  const runTrackers = new Map<string, RunTracker>();

  const refreshSnapshot = async (): Promise<ScriptLibrarySnapshot> => {
    snapshotCache = normalizeSnapshot(await call<BackendSnapshot>('GetScriptLibrarySnapshot', t));
    return snapshotCache;
  };

  const stopTracker = (runId: string) => {
    const tracker = runTrackers.get(runId);
    if (tracker && tracker.timer !== null) globalThis.clearTimeout(tracker.timer);
    if (tracker) tracker.timer = null;
  };

  const schedulePoll = (runId: string, delayMs: number) => {
    const tracker = runTrackers.get(runId);
    if (!tracker || tracker.finished) return;
    if (tracker.timer !== null) globalThis.clearTimeout(tracker.timer);
    tracker.timer = globalThis.setTimeout(() => {
      const current = runTrackers.get(runId);
      if (current) current.timer = null;
      void pollRun(runId);
    }, delayMs) as unknown as number;
  };

  const emitAuditEvents = async (runId: string, tracker: RunTracker) => {
    try {
      const page = await call<BackendAuditPage>('GetSQLAuditEvents', t, {
        source: 'script',
        runId,
        page: 1,
        pageSize: 500,
      });
      (page?.items || []).forEach((event) => {
        if (event.source && event.source !== 'script') return;
        if (isWebRuntime() && String(event.userName || '').trim() !== snapshotCache.owner) return;
        const id = String(event.id || '').trim();
        if (!id) return;
        const sql = String(event.sqlText || '');
        const eventConnectionId = String(event.connectionId || '');
        const eventDatabase = String(event.database || '');
        const binding = tracker.connections.find((item) => (
          String(item.connectionId || '') === eventConnectionId
          && (!item.database || !eventDatabase || item.database === eventDatabase)
        ));
        tracker.observer.onEvent({
          type: 'audit',
          audit: {
            id: `${runId}:${id}`,
            at: Number(event.timestamp) || Date.now(),
            connectionAlias: binding?.alias || eventConnectionId,
            database: eventDatabase,
            sql,
            durationMs: Number(event.durationMs) || 0,
            rowCount: Number(event.rowsReturned || event.rowsAffected) || 0,
            write: /^\s*(insert|update|delete|merge|replace|create|alter|drop|truncate)\b/i.test(sql),
          } satisfies ScriptAuditEntry,
        });
      });
      return (page?.items || []).length >= 500 || Number(page?.total || 0) > (page?.items || []).length;
    } catch {
      // Older desktop builds may not expose SQL audit. Runs still remain usable.
      return false;
    }
  };

  const finishTrackerAsOutcomeUnknown = (runId: string, tracker: RunTracker) => {
    tracker.finished = true;
    stopTracker(runId);
    runTrackers.delete(runId);
    tracker.observer.onEvent({
      type: 'result',
      result: {
        success: false,
        outcomeUnknown: true,
        message: t('script_workbench.error.outcome_unknown'),
        durationMs: Math.max(0, Date.now() - tracker.startedAt),
      },
    });
  };

  const abandonRun = async (runId: string, tracker: RunTracker) => {
    await withScriptWorkbenchTimeout(
      callRaw('CancelScriptWorkbenchRun', runId).catch(() => undefined),
      CANCEL_TIMEOUT_MS,
      'Script cancellation timed out',
      'outcome_unknown',
    ).catch(() => undefined);
    finishTrackerAsOutcomeUnknown(runId, tracker);
  };

  const pollRun = async (runId: string) => {
    const tracker = runTrackers.get(runId);
    if (!tracker || tracker.polling || tracker.finished) return;
    tracker.polling = true;
    let nextDelay = POLL_INTERVAL_MS;
    try {
      let snapshot: BackendRunSnapshot;
      try {
        const timed = createTimedAbortSignal(undefined, POLL_TIMEOUT_MS);
        try {
          const result = await withScriptWorkbenchTimeout(
            callRawWithSignal<BackendRunSnapshot>(
              'GetScriptWorkbenchRun',
              [runId],
              timed.signal,
            ),
            POLL_TIMEOUT_MS + 250,
            'Script poll request timed out',
            'timeout',
          );
          snapshot = throwBackendFailure('GetScriptWorkbenchRun', result, t);
        } catch (pollTimeoutError) {
          if (timed.didTimeout()) {
            throw new ScriptWorkbenchRequestError(
              t('script_workbench.error.request_timeout'),
              'timeout',
            );
          }
          throw pollTimeoutError;
        } finally {
          timed.cleanup();
        }
        tracker.pollFailures = 0;
      } catch (pollError) {
        if (tracker.finished || !runTrackers.has(runId)) return;
        if (
          isTransientScriptWorkbenchError(pollError)
          && tracker.pollFailures < MAX_POLL_FAILURES
        ) {
          tracker.pollFailures += 1;
          nextDelay = Math.min(
            MAX_POLL_INTERVAL_MS,
            POLL_INTERVAL_MS * (2 ** tracker.pollFailures),
          );
          return;
        }
        await abandonRun(runId, tracker);
        return;
      }
      if (tracker.finished || !runTrackers.has(runId)) return;
      const startedAt = Number(snapshot.startedAt) || tracker.startedAt;
      const finishedAt = Number(snapshot.finishedAt) || 0;
      const progressPayload = snapshot.progress || {};
      const current = Number(progressPayload.current || snapshot.dbCalls || 0);
      const total = Number(progressPayload.total || 0) || undefined;
      tracker.observer.onEvent({
        type: 'progress',
        progress: {
          current,
          total,
          message: String(progressPayload.message || '')
            || formatScriptRunStageMessage(snapshot.stage, t),
          startedAt,
          elapsedMs: Math.max(0, (finishedAt || Date.now()) - startedAt),
        },
      });
      (snapshot.logs || []).forEach((entry) => {
        const at = Number(entry.timestamp) || 0;
        const level = ['debug', 'info', 'warn', 'error'].includes(String(entry.level))
          ? entry.level as 'debug' | 'info' | 'warn' | 'error'
          : 'info';
        const message = String(entry.message || '');
        const sequence = Number(entry.sequence);
        const hasSequence = Number.isSafeInteger(sequence) && sequence >= 0;
        const key = hasSequence
          ? `sequence:${sequence}`
          : `${at}\u0000${level}\u0000${message}`;
        if (tracker.seenLogKeys.has(key)) return;
        tracker.seenLogKeys.add(key);
        tracker.observer.onEvent({
          type: 'log',
          log: {
            id: hasSequence
              ? `${runId}:log:${sequence}`
              : `${runId}:log:${at}:${level}:${scriptSourceHash(message)}`,
            at: at || Date.now(),
            level,
            message,
          },
        });
      });
      const outputs = snapshot.outputs || [];
      if (Date.now() >= tracker.nextOutputRetryAt) {
        let outputFailed = false;
        const outputLimit = Math.min(outputs.length, SCRIPT_MAX_OUTPUT_STREAMS);
        for (let index = tracker.outputCount; index < outputLimit; index += 1) {
          try {
            const timed = createTimedAbortSignal(undefined, OUTPUT_TIMEOUT_MS);
            let page: BackendOutputPage;
            try {
              const result = await withScriptWorkbenchTimeout(
                callRawWithSignal<BackendOutputPage>(
                  'GetScriptWorkbenchOutput',
                  [runId, index, 1, 100],
                  timed.signal,
                ),
                OUTPUT_TIMEOUT_MS + 250,
                'Script output request timed out',
                'timeout',
              );
              page = throwBackendFailure('GetScriptWorkbenchOutput', result, t);
            } finally {
              timed.cleanup();
            }
            tracker.observer.onEvent({ type: 'output', output: mapOutputPage(runId, page) });
            tracker.outputCount = index + 1;
          } catch {
            outputFailed = true;
            break;
          }
        }
        if (outputFailed) {
          tracker.outputFailures += 1;
          tracker.nextOutputRetryAt = Date.now() + Math.min(
            MAX_POLL_INTERVAL_MS,
            POLL_INTERVAL_MS * (2 ** tracker.outputFailures),
          );
        } else {
          tracker.outputFailures = 0;
          tracker.outputCount = Math.max(tracker.outputCount, outputLimit);
        }
      }
      if (['succeeded', 'failed', 'cancelled', 'timed_out', 'memory_exceeded'].includes(String(snapshot.status))) {
        tracker.finished = true;
        stopTracker(runId);
        const auditsTruncated = await emitAuditEvents(runId, tracker);
        tracker.observer.onEvent({
          type: 'result',
          result: {
            success: snapshot.status === 'succeeded',
            message: snapshot.memoryExceeded === true || snapshot.status === 'memory_exceeded'
              ? t('script_workbench.status.memory_exceeded')
              : formatScriptRunErrorMessage(snapshot.error, t, snapshot.errorKind),
            durationMs: Math.max(0, (finishedAt || Date.now()) - startedAt),
            cancelled: snapshot.status === 'cancelled' || snapshot.cancelled === true,
            timedOut: snapshot.status === 'timed_out' || snapshot.timedOut === true,
            memoryExceeded: snapshot.memoryExceeded === true || snapshot.status === 'memory_exceeded',
            auditsTruncated,
            logsTruncated: snapshot.logsTruncated === true
              || (snapshot.logs || []).length >= SCRIPT_MAX_LOG_ENTRIES,
            outputsTruncated: snapshot.outputsTruncated === true
              || outputs.length > SCRIPT_MAX_OUTPUT_STREAMS
              || tracker.outputCount < Math.min(outputs.length, SCRIPT_MAX_OUTPUT_STREAMS),
            errorKind: snapshot.errorKind,
          },
        });
        runTrackers.delete(runId);
      }
    } catch {
      if (!tracker.finished) await abandonRun(runId, tracker);
    } finally {
      tracker.polling = false;
      if (!tracker.finished && runTrackers.has(runId)) {
        schedulePoll(runId, nextDelay);
      }
    }
  };

  return {
    async listLibrary() {
      return refreshSnapshot();
    },

    async getScript(id: string) {
      const cached = snapshotCache.scripts.find((script) => script.id === id);
      if (cached) return cached;
      const snapshot = await refreshSnapshot();
      const script = snapshot.scripts.find((candidate) => candidate.id === id);
      if (!script) {
        throw new ScriptWorkbenchRequestError(
          t('script_workbench.error.script_not_found'),
          'script_not_found',
        );
      }
      return script;
    },

    async saveScript(input: SaveScriptInput) {
      return normalizeScript(await call<BackendScript>('SaveScriptLibraryScript', t, {
        ...input,
        id: input.id || undefined,
      }));
    },

    async saveFolder(input: SaveScriptFolderInput) {
      return normalizeFolder(await call<Partial<ScriptLibraryFolder>>('SaveScriptLibraryFolder', t, input));
    },

    async deleteScript(input: DeleteScriptInput) {
      await call('DeleteScriptLibraryScript', t, input);
    },

    async deleteFolder(input: DeleteScriptInput) {
      await call('DeleteScriptLibraryFolder', t, input);
    },

    async shareScript(input) {
      return normalizeScript(await call<BackendScript>('SetScriptLibraryScriptVisibility', t, input));
    },

    async shareFolder(input) {
      return normalizeFolder(await call<Partial<ScriptLibraryFolder>>(
        'SetScriptLibraryFolderVisibility',
        t,
        input,
      ));
    },

    async chooseInputFile() {
      const webBridge = typeof window !== 'undefined'
        ? (window as any).__GONAVI_WEB_RPC__
        : undefined;
      if (isWebRuntime() || typeof webBridge?.invokeWithOptions === 'function') {
        const file = await pickBrowserInputFile();
        if (!file) return null;
        const uploaded = await uploadBrowserFile(file, 'script-input');
        return {
          alias: stemFromFilename(uploaded.name),
          name: uploaded.name,
          reference: uploaded.filePath,
          headerRow: 1,
        };
      }
      const raw = await callRaw<{ path?: string; name?: string }>('SelectScriptInputFile', '');
      if (raw.success === false) {
        const rawMessage = String(raw.message || '').trim();
        if (rawMessage.toLowerCase().includes('cancel') || rawMessage === BACKEND_CANCELLED_MESSAGE) return null;
        throw new ScriptWorkbenchRequestError(
          formatScriptWorkbenchError({ ...raw, kind: raw.kind }, t),
          raw.code,
          raw.params,
          raw.kind,
        );
      }
      const path = String(raw.data?.path || '').trim();
      if (!path) return null;
      const name = String(raw.data?.name || '').trim() || filenameFromPath(path);
      return {
        alias: stemFromFilename(name),
        name,
        path,
        headerRow: 1,
      };
    },

    async listInputSheets(input: ScriptInputBinding) {
      const data = await call<{ sheets?: unknown[] }>('ListScriptInputSheets', t, {
        alias: input.alias,
        path: input.path,
        reference: input.reference,
        name: input.name,
        sheetName: input.sheetName,
      });
      return Array.isArray(data?.sheets)
        ? data.sheets.map((sheet) => String(sheet || '').trim()).filter(Boolean)
        : [];
    },

    async runScript(
      request: ScriptRunRequest,
      observer: ScriptRunObserver,
      signal?: AbortSignal,
    ): Promise<ScriptRunReceipt> {
      const payload = {
        scriptId: request.scriptId,
        script: request.script,
        connections: request.connections,
        inputs: request.inputs,
        allowWrite: request.allowWrite,
        confirmationToken: request.confirmationToken,
        writeApprovalToken: request.confirmationToken,
        batchSize: request.limits.defaultBatch,
        inListLimit: request.limits.defaultInList,
        timeoutMs: request.limits.timeoutMs,
        maxDbCalls: request.limits.maxDbCalls,
        maxOutputRows: request.limits.maxOutputRows ?? 50_000,
        memoryLimitBytes: request.limits.memoryLimitBytes ?? (512 << 20),
      };
      const timed = createTimedAbortSignal(signal, START_TIMEOUT_MS);
      let raw: QueryResult<BackendRunSnapshot>;
      try {
        raw = await withScriptWorkbenchTimeout(
          callRawWithSignal<BackendRunSnapshot>(
            'RunScriptWorkbench',
            [payload],
            timed.signal,
          ),
          START_TIMEOUT_MS + 250,
          'Script start request timed out',
          'outcome_unknown',
        );
      } catch (startError) {
        if (timed.didTimeout()) {
          throw new ScriptWorkbenchRequestError(
            t('script_workbench.error.outcome_unknown'),
            'outcome_unknown',
            undefined,
            'backend',
          );
        }
        throw startError;
      } finally {
        timed.cleanup();
      }
      if (raw.success === false) {
        throw new ScriptWorkbenchRequestError(
          formatScriptWorkbenchError({ ...raw, kind: raw.kind }, t),
          raw.code,
          raw.params,
          raw.kind,
        );
      }
      const runId = String(raw.data?.runId || '').trim();
      if (!runId) {
        throw new ScriptWorkbenchRequestError(
          formatScriptWorkbenchError({ message: 'RunScriptWorkbench returned no run id' }, t),
          'backend_unavailable',
        );
      }
      const startedAt = Number(raw.data?.startedAt) || Date.now();
      const tracker: RunTracker = {
        observer,
        connections: request.connections,
        startedAt,
        seenLogKeys: new Set(),
        outputCount: 0,
        outputFailures: 0,
        pollFailures: 0,
        nextOutputRetryAt: 0,
        finished: false,
        polling: false,
        timer: null,
      };
      runTrackers.set(runId, tracker);
      void pollRun(runId);
      return { runId, startedAt };
    },

    async authorizeWrite(
      request: ScriptWriteAuthorizationRequest,
      signal?: AbortSignal,
    ): Promise<ScriptWriteAuthorization> {
      const raw = await callRawWithSignal<BackendWriteAuthorization>(
        'PrepareScriptWorkbenchWrite',
        [request],
        signal,
      );
      if (raw.success === false) {
        throw new ScriptWorkbenchRequestError(
          formatScriptWorkbenchError({ ...raw, kind: raw.kind }, t),
          raw.code,
          raw.params,
          raw.kind,
        );
      }
      const data = raw.data || {};
      return {
        requiresConfirmation: data.requiresConfirmation === true || data.required === true,
        confirmationToken: String(data.confirmationToken || data.token || '').trim() || undefined,
      };
    },

    async cancelRun(runId: string, signal?: AbortSignal) {
      const tracker = runTrackers.get(runId);
      const timed = createTimedAbortSignal(signal, CANCEL_TIMEOUT_MS);
      try {
        const result = await withScriptWorkbenchTimeout(
          callRawWithSignal(
            'CancelScriptWorkbenchRun',
            [runId],
            timed.signal,
          ),
          CANCEL_TIMEOUT_MS + 250,
          'Script cancellation timed out',
          'outcome_unknown',
        );
        throwBackendFailure('CancelScriptWorkbenchRun', result, t);
      } catch (cancelError) {
        const code = cancelError instanceof ScriptWorkbenchRequestError
          ? cancelError.code
          : '';
        if (timed.didTimeout() || code === 'timeout' || code === 'outcome_unknown') {
          if (tracker && !tracker.finished) {
            finishTrackerAsOutcomeUnknown(runId, tracker);
          }
          return;
        }
        throw cancelError;
      } finally {
        timed.cleanup();
        if (tracker && !tracker.finished && runTrackers.has(runId)) {
          void pollRun(runId);
        }
      }
    },

    async getOutputPage(outputId: string, page: number, pageSize: number, signal?: AbortSignal) {
      const [runId, indexText] = outputId.split(':');
      const outputIndex = Number(indexText);
      if (
        !String(runId || '').trim()
        || !Number.isSafeInteger(outputIndex)
        || outputIndex < 0
        || !Number.isSafeInteger(page)
        || page <= 0
        || !Number.isSafeInteger(pageSize)
        || pageSize <= 0
      ) {
        throw new ScriptWorkbenchRequestError(
          t('script_workbench.error.invalid_input'),
          'invalid_input',
        );
      }
      const result = await callRawWithSignal<BackendOutputPage>(
        'GetScriptWorkbenchOutput',
        [
          runId,
          outputIndex,
          page,
          pageSize,
        ],
        signal,
      );
      const pageResult = throwBackendFailure('GetScriptWorkbenchOutput', result, t);
      return mapOutputPage(runId, pageResult);
    },

    dispose() {
      runTrackers.forEach((tracker, runId) => {
        tracker.finished = true;
        stopTracker(runId);
        void callRaw('CancelScriptWorkbenchRun', runId).catch(() => undefined);
      });
      runTrackers.clear();
    },
  };
};
