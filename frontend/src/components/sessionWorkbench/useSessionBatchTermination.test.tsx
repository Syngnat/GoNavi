import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionBatchTermination } from './useSessionBatchTermination';

const capability = {
  supported: true,
  canCancelQuery: false,
  canTerminateSession: true,
  terminateTarget: 'sessionId' as const,
};

const sessions = [
  { key: 'db:1', sessionId: '1', statement: 'SELECT SLEEP(30)' },
  { key: 'db:2', sessionId: '2', statement: 'SELECT SLEEP(60)' },
];

describe('useSessionBatchTermination', () => {
  let renderer: ReactTestRenderer | null = null;
  let latest!: ReturnType<typeof useSessionBatchTermination>;

  const Probe = () => {
    latest = useSessionBatchTermination({
      capability,
      workbench: { executeActionBatch: batch },
      contextKey: 'scope-a',
      t: (key) => key,
      messageApi,
    });
    return null;
  };

  const batch = vi.fn();
  const messageApi = {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    batch.mockReset();
    messageApi.success.mockReset();
    messageApi.warning.mockReset();
    messageApi.error.mockReset();
  });

  const render = () => {
    act(() => {
      renderer = create(<Probe />);
    });
  };

  it('reports partial success from one batch call', async () => {
    batch.mockResolvedValue({
      total: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { index: 0, success: true },
        { index: 1, success: false, message: 'gone' },
      ],
    });
    render();

    act(() => latest.open({ sessions, skippedCount: 0, totalVisible: 2 }));
    await act(async () => {
      await latest.confirm();
    });

    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0]).toHaveLength(2);
    expect(messageApi.warning).toHaveBeenCalledWith('session_workbench.batch.partial');
    expect(latest.target).toBeNull();
  });

  it('closes a stale batch without reporting success', async () => {
    batch.mockResolvedValue({
      total: 2,
      succeeded: 2,
      failed: 0,
      results: [],
      stale: true,
    });
    render();

    act(() => latest.open({ sessions, skippedCount: 0, totalVisible: 2 }));
    await act(async () => {
      await latest.confirm();
    });

    expect(messageApi.warning).toHaveBeenCalledWith('session_workbench.batch.stale');
    expect(messageApi.success).not.toHaveBeenCalled();
  });
});
