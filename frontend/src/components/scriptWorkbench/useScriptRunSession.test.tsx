/** @vitest-environment jsdom */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScriptRunSession } from './useScriptRunSession';
import type {
  ScriptOutputPage,
  ScriptRunObserver,
  ScriptRunRequest,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';

const request: ScriptRunRequest = {
  script: 'gonavi.output("rows", []);',
  connections: [],
  inputs: [],
  allowWrite: false,
  limits: {
    timeoutMs: 30_000,
    maxDbCalls: 10_000,
    defaultBatch: 500,
    maxBatch: 5_000,
    defaultInList: 1_000,
    maxInList: 1_000,
    defaultQueryRows: 10_000,
    maxQueryRows: 50_000,
  },
};

const createAdapter = (): ScriptWorkbenchAdapter => ({
  listLibrary: vi.fn(),
  getScript: vi.fn(),
  saveScript: vi.fn(),
  saveFolder: vi.fn(),
  deleteScript: vi.fn(),
  deleteFolder: vi.fn(),
  shareScript: vi.fn(),
  shareFolder: vi.fn(),
  chooseInputFile: vi.fn(),
  listInputSheets: vi.fn(async () => []),
  authorizeWrite: vi.fn(),
  runScript: vi.fn(),
  cancelRun: vi.fn(async () => undefined),
  getOutputPage: vi.fn(),
});

const output = (outputId: string, page: number): ScriptOutputPage => ({
  outputId,
  name: 'rows',
  columns: ['value'],
  rows: [{ value: page }],
  page,
  pageSize: 100,
  totalRows: 10,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const mountHook = async (adapter: ScriptWorkbenchAdapter) => {
  let api!: ReturnType<typeof useScriptRunSession>;
  const Probe: React.FC = () => {
    api = useScriptRunSession(adapter);
    return null;
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe />);
  });
  return { getApi: () => api, renderer };
};

describe('useScriptRunSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels a run that was requested before the start RPC returned', async () => {
    const adapter = createAdapter();
    const pendingRun = deferred<{ runId: string; startedAt: number }>();
    adapter.runScript = vi.fn(() => pendingRun.promise);
    const hook = await mountHook(adapter);

    await act(async () => {
      const startPromise = hook.getApi().start(request);
      await Promise.resolve();
      const cancelPromise = hook.getApi().cancel();
      expect(hook.getApi().status).toBe('cancelling');
      pendingRun.resolve({ runId: 'run-early-cancel', startedAt: 1 });
      await Promise.all([startPromise, cancelPromise]);
    });

    expect(adapter.cancelRun).toHaveBeenCalledWith('run-early-cancel');
    expect(hook.getApi().status).toBe('cancelling');
    act(() => hook.renderer.unmount());
  });

  it('cancels the late receipt after reset and ignores its old observer', async () => {
    const adapter = createAdapter();
    let observer!: ScriptRunObserver;
    const pendingRun = deferred<{ runId: string; startedAt: number }>();
    adapter.runScript = vi.fn((_request, nextObserver) => {
      observer = nextObserver;
      return pendingRun.promise;
    });
    const hook = await mountHook(adapter);

    await act(async () => {
      const startPromise = hook.getApi().start(request);
      await Promise.resolve();
      await hook.getApi().reset();
      pendingRun.resolve({ runId: 'run-reset', startedAt: 1 });
      await startPromise;
    });
    expect(adapter.cancelRun).toHaveBeenCalledWith('run-reset');

    await act(async () => {
      observer.onEvent({
        type: 'progress',
        progress: { current: 1, total: 2, startedAt: 1, elapsedMs: 1 },
      });
    });
    expect(hook.getApi().status).toBe('idle');
    act(() => hook.renderer.unmount());
  });

  it('keeps the newest output page and aborts the superseded request', async () => {
    const adapter = createAdapter();
    adapter.runScript = vi.fn(async (_request, observer) => {
      observer.onEvent({ type: 'output', output: output('run-page:0', 1) });
      observer.onEvent({ type: 'result', result: { success: true, durationMs: 1 } });
      return { runId: 'run-page', startedAt: 1 };
    });
    const firstPage = deferred<ScriptOutputPage>();
    const secondPage = deferred<ScriptOutputPage>();
    let firstSignal: AbortSignal | undefined;
    adapter.getOutputPage = vi.fn()
      .mockImplementationOnce((_outputId, _page, _pageSize, signal) => {
        firstSignal = signal;
        return firstPage.promise;
      })
      .mockImplementationOnce(() => secondPage.promise);
    const hook = await mountHook(adapter);
    await act(async () => {
      await hook.getApi().start(request);
    });

    await act(async () => {
      const older = hook.getApi().loadOutputPage('run-page:0', 2, 100);
      const newer = hook.getApi().loadOutputPage('run-page:0', 3, 100);
      secondPage.resolve(output('run-page:0', 3));
      await newer;
      firstPage.resolve(output('run-page:0', 2));
      await older;
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(hook.getApi().output?.page).toBe(3);
    act(() => hook.renderer.unmount());
  });

  it('turns a hanging start request into an unknown outcome after the timeout', async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    adapter.runScript = vi.fn((_request, _observer, signal) => new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    }));
    const hook = await mountHook(adapter);

    await act(async () => {
      void hook.getApi().start(request);
      await vi.advanceTimersByTimeAsync(31_000);
      await Promise.resolve();
    });

    expect(hook.getApi().status).toBe('outcome_unknown');
    act(() => hook.renderer.unmount());
  });

  it('turns a hanging cancellation into an unknown outcome after the timeout', async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    adapter.runScript = vi.fn(async () => ({ runId: 'run-cancel-timeout', startedAt: 1 }));
    adapter.cancelRun = vi.fn(() => new Promise<void>(() => undefined));
    const hook = await mountHook(adapter);
    await act(async () => {
      await hook.getApi().start(request);
    });

    await act(async () => {
      void hook.getApi().cancel();
      await vi.advanceTimersByTimeAsync(11_000);
      await Promise.resolve();
    });

    expect(hook.getApi().status).toBe('outcome_unknown');
    act(() => hook.renderer.unmount());
  });
});
