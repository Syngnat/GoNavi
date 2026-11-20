import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMockScriptWorkbenchMethods } from './browserMockScriptWorkbenchMethods';

describe('browser mock script workbench methods', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a write token and rejects write runs without one', async () => {
    vi.useFakeTimers();
    const methods = createBrowserMockScriptWorkbenchMethods();
    const approval = await methods.PrepareScriptWorkbenchWrite({ allowWrite: true });

    expect(approval).toMatchObject({
      success: true,
      data: {
        requiresConfirmation: true,
        confirmationToken: expect.any(String),
      },
    });
    await expect(methods.RunScriptWorkbench({ allowWrite: true })).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('approval token'),
    });
    const run = await methods.RunScriptWorkbench({
      allowWrite: true,
      confirmationToken: approval.data.confirmationToken,
    });
    expect(run).toMatchObject({ success: true, data: { runId: expect.any(String) } });
    await methods.CancelScriptWorkbenchRun(String(run.data?.runId || ''));
  });
});
