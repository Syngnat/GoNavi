import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '../../store';
import {
  DEFAULT_AI_RUN_RUNTIME_CONFIG,
  NANOSECONDS_PER_SECOND,
} from './aiRunPolicy';
import { buildDesktopWorkspaceSnapshot } from './useAIWorkspaceSnapshot';
import {
  resetAIWorkspaceSnapshotCursor,
  useAIWorkspaceSnapshot,
} from './useAIWorkspaceSnapshot';

const HookHarness: React.FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  useAIWorkspaceSnapshot({ enabled });
  return null;
};

describe('buildDesktopWorkspaceSnapshot', () => {
  it('publishes shortcut bindings using the Go map[string]string contract', () => {
    const snapshot = buildDesktopWorkspaceSnapshot({
      tabs: [],
      activeTabId: null,
      activeContext: null,
      aiContexts: {},
      savedQueries: [],
      sqlSnippets: [],
      externalSQLDirectories: [],
      sqlLogs: [],
      shortcutOptions: {
        runQuery: {
          mac: { combo: 'Meta+Enter', enabled: true },
          windows: { combo: 'Ctrl+Enter', enabled: false },
        },
      },
    }, 12, 'desktop-main', 'instance-1');

    expect(snapshot.shortcuts).toEqual({
      'runQuery.mac.combo': 'Meta+Enter',
      'runQuery.mac.enabled': 'true',
      'runQuery.windows.combo': 'Ctrl+Enter',
      'runQuery.windows.enabled': 'false',
    });
    const shortcutValues = Object.values(snapshot.shortcuts as Record<string, unknown>);
    expect(shortcutValues.every((value: unknown) => typeof value === 'string')).toBe(true);
  });

  it('uses an empty shortcut map when the store has no shortcut options', () => {
    const snapshot = buildDesktopWorkspaceSnapshot({
      tabs: [],
      activeTabId: null,
      activeContext: null,
      aiContexts: {},
      savedQueries: [],
      sqlSnippets: [],
      externalSQLDirectories: [],
      sqlLogs: [],
      shortcutOptions: undefined,
    }, 1, 'desktop-main', 'instance-1');

    expect(snapshot.shortcuts).toEqual({});
  });
});

describe('useAIWorkspaceSnapshot lease renewal', () => {
  const originalStoreState = useStore.getState();
  let renderer: ReactTestRenderer | undefined;
  let service: {
    AIGetRunPolicy: ReturnType<typeof vi.fn>;
    AIUpdateWorkspaceSnapshot: ReturnType<typeof vi.fn>;
  };
  let listeners: Map<string, Set<EventListener>>;
  let eventControls: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  const installWindow = () => {
    listeners = new Map();
    const addEventListener = vi.fn((name: string, listener: EventListener) => {
      const entries = listeners.get(name) || new Set<EventListener>();
      entries.add(listener);
      listeners.set(name, entries);
    });
    const removeEventListener = vi.fn((name: string, listener: EventListener) => {
      listeners.get(name)?.delete(listener);
    });
    service = {
      AIGetRunPolicy: vi.fn(),
      AIUpdateWorkspaceSnapshot: vi.fn().mockResolvedValue({ accepted: true }),
    };
    vi.stubGlobal('window', {
      go: { aiservice: { Service: service } },
      addEventListener,
      removeEventListener,
    });
    eventControls = { addEventListener, removeEventListener };
    return eventControls;
  };

  const emitConfigChanged = () => {
    for (const listener of [...(listeners.get('gonavi:ai:config-changed') || [])]) {
      listener(new Event('gonavi:ai:config-changed'));
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetAIWorkspaceSnapshotCursor();
    installWindow();
    useStore.setState({
      activeContext: null,
      tabs: [],
      activeTabId: null,
      aiContexts: {},
      savedQueries: [],
      sqlSnippets: [],
      externalSQLDirectories: [],
      shortcutOptions: {} as any,
      sqlEditorPendingTransactions: {},
      sqlEditorTransactionOptions: {} as any,
      dataEditTransactionOptions: {} as any,
      sqlLogs: [],
    });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    useStore.setState(originalStoreState, true);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not require a browser window while a detached surface is rendered server-side', async () => {
    vi.unstubAllGlobals();

    await expect(act(async () => {
      renderer = create(React.createElement(HookHarness));
      await Promise.resolve();
    })).resolves.toBeUndefined();
  });

  it('uses the configured renewal interval and retries publication with the latest snapshot', async () => {
    service.AIGetRunPolicy.mockResolvedValue({
      schemaVersion: 1,
      revision: 2,
      policy: {},
      runtime: {
        controlPollInterval: 200_000_000,
        workspaceSnapshotRenewInterval: 20_000_000,
        workspaceSnapshotLeaseDuration: 100_000_000,
        policyWatchInterval: 500_000_000,
      },
    });

    await act(async () => {
      renderer = create(React.createElement(HookHarness));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(service.AIGetRunPolicy).toHaveBeenCalledTimes(1);
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(1);

    useStore.setState({ activeContext: { connectionId: 'updated', dbName: 'updated_db' } });
    await act(async () => { await Promise.resolve(); });
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => { vi.advanceTimersByTime(19); });
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(3);
    expect(service.AIUpdateWorkspaceSnapshot.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      revision: 3,
      activeContext: expect.objectContaining({ connectionId: 'updated' }),
    }));
  });

  it('rebuilds the timer after a policy change event and rejects an invalid runtime tuple to defaults', async () => {
    service.AIGetRunPolicy
      .mockResolvedValueOnce({
        schemaVersion: 1,
        revision: 1,
        policy: {},
        runtime: {
          controlPollInterval: 100_000_000,
          workspaceSnapshotRenewInterval: 10_000_000,
          workspaceSnapshotLeaseDuration: 50_000_000,
          policyWatchInterval: 500_000_000,
        },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        revision: 2,
        policy: {},
        runtime: {
          controlPollInterval: 100_000_000,
          workspaceSnapshotRenewInterval: 50_000_000,
          workspaceSnapshotLeaseDuration: 50_000_000,
          policyWatchInterval: 500_000_000,
        },
      });

    await act(async () => {
      renderer = create(React.createElement(HookHarness));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { vi.advanceTimersByTime(10); });
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(2);

    emitConfigChanged();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(service.AIGetRunPolicy).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(49); });
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    // Invalid policy falls back to 5 seconds, so the replacement timer has
    // not fired after 50ms.
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(2);

    expect(DEFAULT_AI_RUN_RUNTIME_CONFIG.workspaceSnapshotRenewInterval)
      .toBe(5 * NANOSECONDS_PER_SECOND);
  });

  it('retries the policy read after a transient startup failure and adopts the recovered cadence', async () => {
    service.AIGetRunPolicy
      .mockRejectedValueOnce(new Error('ledger warming up'))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        revision: 3,
        policy: {},
        runtime: {
          controlPollInterval: 100_000_000,
          workspaceSnapshotRenewInterval: 20_000_000,
          workspaceSnapshotLeaseDuration: 100_000_000,
          policyWatchInterval: 500_000_000,
        },
      });

    await act(async () => {
      renderer = create(React.createElement(HookHarness));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(service.AIGetRunPolicy).toHaveBeenCalledTimes(1);

    // A default-cadence renewal doubles as a recovery probe. Once the service
    // is back, the timer is replaced with the configured 20ms cadence.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(service.AIGetRunPolicy).toHaveBeenCalledTimes(2);

    const callsAfterRecovery = service.AIUpdateWorkspaceSnapshot.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(19); });
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(callsAfterRecovery);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(callsAfterRecovery + 1);
  });

  it('cleans up the renewal timer and config listener on unmount', async () => {
    service.AIGetRunPolicy.mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      policy: {},
      runtime: {
        controlPollInterval: 100_000_000,
        workspaceSnapshotRenewInterval: 10_000_000,
        workspaceSnapshotLeaseDuration: 50_000_000,
        policyWatchInterval: 500_000_000,
      },
    });
    const events = eventControls;
    await act(async () => {
      renderer = create(React.createElement(HookHarness));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(events.addEventListener).toHaveBeenCalledTimes(1);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    expect(events.removeEventListener).toHaveBeenCalledTimes(1);
    const count = service.AIUpdateWorkspaceSnapshot.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(service.AIUpdateWorkspaceSnapshot).toHaveBeenCalledTimes(count);
  });
});
