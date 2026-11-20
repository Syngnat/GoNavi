/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScriptWorkbenchBackendAdapter } from './scriptWorkbenchBackendAdapter';
import { pickBrowserInputFile } from './scriptWorkbenchBrowserInput';
import type { ScriptRunEvent } from './scriptWorkbenchTypes';

const t = (key: string) => key;

const installAppBridge = (methods: Record<string, ReturnType<typeof vi.fn>>) => {
  (window as any).go = { app: { App: methods } };
};

describe('script workbench backend adapter', () => {
  beforeEach(() => {
    delete (window as any).go;
    delete (window as any).__GONAVI_WEB_RPC__;
    delete (window as any).__GONAVI_WEB_RUNTIME__;
    vi.useRealTimers();
  });

  afterEach(() => {
    delete (window as any).go;
    delete (window as any).__GONAVI_WEB_RPC__;
    delete (window as any).__GONAVI_WEB_RUNTIME__;
    vi.useRealTimers();
  });

  it('loads the real script library snapshot and saves through the Wails methods', async () => {
    const snapshot = {
      owner: 'local',
      scripts: [{
        id: 'script-1',
        name: 'Audit',
        code: 'gonavi.output("rows", []);',
        owner: 'local',
        visibility: 'private',
        connections: [],
        inputs: [],
        allowWrite: false,
        batchSize: 500,
        inListLimit: 1000,
        canEdit: true,
        canShare: true,
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
      }],
      folders: [],
      canWrite: true,
      canShare: true,
      sharedOnly: false,
    };
    const getSnapshot = vi.fn(async () => ({ success: true, data: snapshot }));
    const saveScript = vi.fn(async (input) => ({
      success: true,
      data: { ...snapshot.scripts[0], ...input, id: 'script-2' },
    }));
    installAppBridge({
      GetScriptLibrarySnapshot: getSnapshot,
      SaveScriptLibraryScript: saveScript,
    });
    const adapter = createScriptWorkbenchBackendAdapter(t);

    await expect(adapter.listLibrary()).resolves.toMatchObject({
      owner: 'local',
      canWrite: true,
      scripts: [expect.objectContaining({
        id: 'script-1',
        name: 'Audit',
        canEdit: true,
        canShare: true,
      })],
    });
    await adapter.saveScript({
      name: 'New script',
      code: 'gonavi.log("ok");',
      visibility: 'private',
      connections: [],
      inputs: [],
      allowWrite: false,
      batchSize: 500,
      inListLimit: 1000,
      revision: 0,
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(saveScript).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New script',
      code: 'gonavi.log("ok");',
    }));
  });

  it('uses the real desktop file dialog binding for script inputs', async () => {
    const selectFile = vi.fn(async () => ({
      success: true,
      data: { path: '/tmp/customer ids.xlsx', name: 'customer ids.xlsx' },
    }));
    installAppBridge({ SelectScriptInputFile: selectFile });
    const adapter = createScriptWorkbenchBackendAdapter(t);

    await expect(adapter.chooseInputFile()).resolves.toMatchObject({
      alias: 'customer-ids',
      name: 'customer ids.xlsx',
      path: '/tmp/customer ids.xlsx',
      headerRow: 1,
    });
    expect(selectFile).toHaveBeenCalledWith('');
  });

  it('normalizes input aliases with the same rules as connection aliases', async () => {
    const longName = `2026 ${'orders-'.repeat(20)}.xlsx`;
    installAppBridge({
      SelectScriptInputFile: vi.fn(async () => ({
        success: true,
        data: { path: `/tmp/${longName}`, name: longName },
      })),
    });
    const adapter = createScriptWorkbenchBackendAdapter(t);

    const selected = await adapter.chooseInputFile();
    expect(selected?.alias).toMatch(/^_2026-/);
    expect(selected?.alias.length).toBeLessThanOrEqual(64);
  });

  it('cleans up the browser file input when returning focus indicates cancellation', async () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);

    const pending = pickBrowserInputFile();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeNull();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    click.mockRestore();
  });

  it('routes every method through the Web RPC bridge when it is available', async () => {
    const invokeWithOptions = vi.fn(async () => ({
      success: true,
      data: {
        owner: 'web-user',
        scripts: [],
        folders: [],
        canWrite: true,
        canShare: true,
        sharedOnly: false,
      },
    }));
    (window as any).__GONAVI_WEB_RPC__ = { invokeWithOptions };
    const adapter = createScriptWorkbenchBackendAdapter(t);

    await expect(adapter.listLibrary()).resolves.toMatchObject({
      owner: 'web-user',
      canWrite: true,
    });
    expect(invokeWithOptions).toHaveBeenCalledWith(
      'app',
      'App',
      'GetScriptLibrarySnapshot',
      [],
      {},
    );
  });

  it('polls the real run and output methods and maps the terminal result', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-1', startedAt: 1_000, status: 'queued' },
    }));
    const getRun = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        data: {
          runId: 'run-1',
          status: 'running',
          stage: 'query',
          startedAt: 1_000,
          dbCalls: 1,
          progress: { current: 5, total: 10, message: 'working' },
          logs: [{ sequence: 1, timestamp: 1_100, level: 'info', message: 'batch 1' }],
          outputs: [{ index: 0, name: 'rows', columns: ['id'], rowCount: 1 }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          runId: 'run-1',
          status: 'succeeded',
          stage: 'succeeded',
          startedAt: 1_000,
          finishedAt: 1_500,
          progress: { current: 10, total: 10 },
          logs: [{ sequence: 1, timestamp: 1_150, level: 'info', message: 'batch 1' }],
          logsTruncated: true,
          outputsTruncated: true,
          outputs: [{ index: 0, name: 'rows', columns: ['id'], rowCount: 1 }],
        },
      });
    const getOutput = vi.fn(async () => ({
      success: true,
      data: {
        outputIndex: 0,
        name: 'rows',
        columns: ['id'],
        rows: [{ id: 7 }],
        total: 1,
        page: 1,
        pageSize: 100,
      },
    }));
    const getAudit = vi.fn(async () => ({
      success: true,
      data: {
        items: [{
          id: 'audit-1',
          timestamp: 1_200,
          connectionId: 'conn-1',
          database: 'app',
          sqlText: 'SELECT 7',
          durationMs: 4,
          rowsReturned: 1,
          source: 'script',
        }],
      },
    }));
    installAppBridge({
      RunScriptWorkbench: run,
      GetScriptWorkbenchRun: getRun,
      GetScriptWorkbenchOutput: getOutput,
      GetSQLAuditEvents: getAudit,
    });
    const events: ScriptRunEvent[] = [];
    const adapter = createScriptWorkbenchBackendAdapter(t);
    await adapter.runScript({
      script: 'gonavi.output("rows", []);',
      connections: [{ alias: 'prod', connectionId: 'conn-1', database: 'app' }],
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
    }, { onEvent: (event) => events.push(event) });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      script: 'gonavi.output("rows", []);',
      allowWrite: false,
    }));
    expect(getRun).toHaveBeenCalledWith('run-1');
    expect(getOutput).toHaveBeenCalledWith('run-1', 0, 1, 100);
    expect(getAudit).toHaveBeenCalledWith(expect.objectContaining({ source: 'script', runId: 'run-1' }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'log' }),
      expect.objectContaining({ type: 'output' }),
      expect.objectContaining({ type: 'audit' }),
      expect.objectContaining({
        type: 'result',
        result: expect.objectContaining({ success: true }),
      }),
    ]));
    expect(events.filter((event) => event.type === 'log')).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        result: expect.objectContaining({ logsTruncated: true, outputsTruncated: true }),
      }),
    ]));
    adapter.dispose?.();
  });

  it('accepts both write approval response shapes and forwards the token once', async () => {
    vi.useFakeTimers();
    const prepare = vi.fn(async () => ({
      success: true,
      data: { required: true, token: 'approval-token-1' },
    }));
    const run = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-write-1', startedAt: 1_000, status: 'queued' },
    }));
    const getRun = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-write-1', status: 'running', startedAt: 1_000 },
    }));
    installAppBridge({
      PrepareScriptWorkbenchWrite: prepare,
      RunScriptWorkbench: run,
      GetScriptWorkbenchRun: getRun,
    });
    const adapter = createScriptWorkbenchBackendAdapter(t);
    const authorization = await adapter.authorizeWrite({
      script: 'gonavi.log("write");',
      connections: [],
      inputs: [],
      allowWrite: true,
      batchSize: 500,
      inListLimit: 1_000,
      timeoutMs: 30_000,
    });

    expect(authorization).toEqual({
      requiresConfirmation: true,
      confirmationToken: 'approval-token-1',
    });
    await adapter.runScript({
      script: 'gonavi.log("write");',
      connections: [],
      inputs: [],
      allowWrite: true,
      confirmationToken: authorization.confirmationToken,
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
    }, { onEvent: vi.fn() });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      allowWrite: true,
      confirmationToken: 'approval-token-1',
      writeApprovalToken: 'approval-token-1',
    }));
    adapter.dispose?.();
  });

  it('includes columns discovered in later rows and rejects unsafe page inputs', async () => {
    const getOutput = vi.fn(async () => ({
      success: true,
      data: {
        outputIndex: 0,
        name: 'rows',
        columns: ['id'],
        rows: [{ id: 1 }, { id: 2, display_name: 'Two' }],
        total: 2,
        page: 1,
        pageSize: 100,
      },
    }));
    installAppBridge({ GetScriptWorkbenchOutput: getOutput });
    const adapter = createScriptWorkbenchBackendAdapter(t);

    const page = await adapter.getOutputPage('run-1:0', 1, 100);
    expect(page.columns).toEqual(['id', 'display_name']);
    await expect(adapter.getOutputPage('run-1:0', 0, 100)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(adapter.getOutputPage('run-1:0', 1, Number.NaN)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(getOutput).toHaveBeenCalledTimes(1);
  });

  it('retries transient GetRun failures with bounded backoff instead of failing the run', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-transient', startedAt: 1_000, status: 'queued' },
    }));
    const getRun = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-transient', status: 'running', startedAt: 1_000 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          runId: 'run-transient',
          status: 'succeeded',
          startedAt: 1_000,
          finishedAt: 1_500,
          outputs: [],
          logs: [],
        },
      });
    installAppBridge({ RunScriptWorkbench: run, GetScriptWorkbenchRun: getRun });
    const events: ScriptRunEvent[] = [];
    const adapter = createScriptWorkbenchBackendAdapter(t);
    await adapter.runScript({
      script: 'gonavi.log("ok");',
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
    }, { onEvent: (event) => events.push(event) });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(1_600);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);

    expect(getRun).toHaveBeenCalledTimes(4);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        result: expect.objectContaining({ success: true }),
      }),
    ]));
    adapter.dispose?.();
  });

  it('keeps a successful run successful when an output page is temporarily unavailable', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-output-error', startedAt: 1_000, status: 'queued' },
    }));
    const getRun = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        data: {
          runId: 'run-output-error',
          status: 'running',
          startedAt: 1_000,
          outputs: [{ index: 0, name: 'rows', columns: ['id'], rowCount: 1 }],
          logs: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          runId: 'run-output-error',
          status: 'succeeded',
          startedAt: 1_000,
          finishedAt: 1_500,
          outputs: [{ index: 0, name: 'rows', columns: ['id'], rowCount: 1 }],
          logs: [],
        },
      });
    const getOutput = vi.fn(async () => {
      throw new Error('temporary output unavailable');
    });
    installAppBridge({
      RunScriptWorkbench: run,
      GetScriptWorkbenchRun: getRun,
      GetScriptWorkbenchOutput: getOutput,
    });
    const events: ScriptRunEvent[] = [];
    const adapter = createScriptWorkbenchBackendAdapter(t);
    await adapter.runScript({
      script: 'gonavi.output("rows", [{ id: 1 }]);',
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
    }, { onEvent: (event) => events.push(event) });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        result: expect.objectContaining({ success: true, outputsTruncated: true }),
      }),
    ]));
    adapter.dispose?.();
  });

  it('releases a hung poll and retries instead of leaving polling stuck', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-hung-poll', startedAt: 1_000, status: 'queued' },
    }));
    const getRun = vi.fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        success: true,
        data: {
          runId: 'run-hung-poll',
          status: 'succeeded',
          startedAt: 1_000,
          finishedAt: 1_500,
          outputs: [],
          logs: [],
        },
      });
    installAppBridge({ RunScriptWorkbench: run, GetScriptWorkbenchRun: getRun });
    const events: ScriptRunEvent[] = [];
    const adapter = createScriptWorkbenchBackendAdapter(t);
    await adapter.runScript({
      script: 'gonavi.log("ok");',
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
    }, { onEvent: (event) => events.push(event) });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_250);
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(0);

    expect(getRun).toHaveBeenCalledTimes(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        result: expect.objectContaining({ success: true }),
      }),
    ]));
    adapter.dispose?.();
  });

  it('requests cancellation and reports an unknown outcome after an unrecoverable poll error', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-unknown', startedAt: 1_000, status: 'queued' },
    }));
    const getRun = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    });
    const cancel = vi.fn(async () => ({ success: true, data: { runId: 'run-unknown' } }));
    installAppBridge({
      RunScriptWorkbench: run,
      GetScriptWorkbenchRun: getRun,
      CancelScriptWorkbenchRun: cancel,
    });
    const events: ScriptRunEvent[] = [];
    const adapter = createScriptWorkbenchBackendAdapter(t);
    await adapter.runScript({
      script: 'gonavi.log("ok");',
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
    }, { onEvent: (event) => events.push(event) });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(cancel).toHaveBeenCalledWith('run-unknown');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        result: expect.objectContaining({
          success: false,
          outcomeUnknown: true,
          message: 'script_workbench.error.outcome_unknown',
        }),
      }),
    ]));
    adapter.dispose?.();
  });

  it('releases the tracker when cancellation itself times out', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-cancel-timeout', startedAt: 1_000, status: 'queued' },
    }));
    const getRun = vi.fn(async () => ({
      success: true,
      data: { runId: 'run-cancel-timeout', status: 'running', startedAt: 1_000 },
    }));
    const cancel = vi.fn(() => new Promise(() => undefined));
    installAppBridge({
      RunScriptWorkbench: run,
      GetScriptWorkbenchRun: getRun,
      CancelScriptWorkbenchRun: cancel,
    });
    const events: ScriptRunEvent[] = [];
    const adapter = createScriptWorkbenchBackendAdapter(t);
    await adapter.runScript({
      script: 'gonavi.log("ok");',
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
    }, { onEvent: (event) => events.push(event) });
    await vi.advanceTimersByTimeAsync(0);

    const cancelPromise = adapter.cancelRun('run-cancel-timeout');
    await vi.advanceTimersByTimeAsync(10_250);
    await cancelPromise;
    const callsAfterTimeout = getRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(getRun.mock.calls.length).toBe(callsAfterTimeout);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'result',
        result: expect.objectContaining({ outcomeUnknown: true }),
      }),
    ]));
    adapter.dispose?.();
  });
});
