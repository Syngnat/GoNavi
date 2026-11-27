import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  workbench: null as any,
  lockWaits: null as any,
  lockWaitOptions: null as any,
  dialogOptions: null as any,
  toolbarProps: null as any,
  tableProps: null as any,
  switchProps: null as any,
  lockPanelProps: null as any,
  batchOptions: null as any,
  batchOpen: vi.fn(),
}));

vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('antd', () => ({
  Alert: () => <div />,
  Empty: () => <div />,
  Spin: () => <div />,
  Segmented: (props: any) => {
    harness.switchProps = props;
    return null;
  },
  message: { useMessage: () => [{}, null] },
}));

vi.mock('./useSessionWorkbench', () => ({
  useSessionWorkbench: () => harness.workbench,
}));

vi.mock('./useLockWaits', () => ({
  useLockWaits: (options: any) => {
    harness.lockWaitOptions = options;
    return harness.lockWaits;
  },
}));

vi.mock('./useSessionWorkbenchDialogs', () => ({
  useSessionWorkbenchDialogs: (options: any) => {
    harness.dialogOptions = options;
    return {
      chooserRow: null,
      confirmRow: null,
      confirmAction: null,
      confirmLoading: false,
      handleRowAction: vi.fn(),
      selectAction: vi.fn(),
      closeChooser: vi.fn(),
      closeConfirmation: vi.fn(),
      handleConfirm: vi.fn(),
    };
  },
}));

vi.mock('./useSessionBatchTermination', () => ({
  useSessionBatchTermination: (options: any) => {
    harness.batchOptions = options;
    return {
      target: null,
      loading: false,
      open: harness.batchOpen,
      close: vi.fn(),
      confirm: vi.fn(),
    };
  },
}));

vi.mock('./SessionToolbar', () => ({
  default: (props: any) => {
    harness.toolbarProps = props;
    return null;
  },
}));

vi.mock('./SessionTable', () => ({
  default: (props: any) => {
    harness.tableProps = props;
    return null;
  },
}));

vi.mock('./LockWaitPanel', () => ({
  default: (props: any) => {
    harness.lockPanelProps = props;
    return null;
  },
}));

vi.mock('./SessionHeader', () => ({ default: (props: any) => <div>{props.extra}</div> }));
vi.mock('../sessionAlerts/SessionAlertSettingsButton', () => ({ default: () => null }));
vi.mock('../sessionAlerts/SessionAlertHistoryPanel', () => ({ default: () => <div>alert-history-panel</div> }));
vi.mock('./SessionSummary', () => ({ default: () => null }));
vi.mock('./SessionActionChooser', () => ({ default: () => null }));
vi.mock('./SessionBatchTerminateModal', () => ({ default: () => null }));
vi.mock('./SessionConfirmModal', () => ({ default: () => null }));

import SessionWorkbench from './SessionWorkbench';

const sessions = [
  {
    key: 'running',
    sessionId: '1',
    state: 'Query',
    statement: 'SELECT SLEEP(30)',
    databaseOrTenant: 'shop',
  },
  {
    key: 'idle',
    sessionId: '2',
    state: 'Sleep',
    statement: '',
    databaseOrTenant: 'shop',
  },
];

const buildWorkbench = (runningOnly: boolean, overrides: Record<string, unknown> = {}) => ({
  connections: [],
  selectedConnection: { id: 'c1', name: 'Local', config: { type: 'mysql' } },
  selectedConnectionId: 'c1',
  setSelectedConnectionId: vi.fn(),
  databaseName: 'shop',
  selectDatabase: vi.fn(),
  filter: '',
  setFilter: vi.fn(),
  runningOnly,
  setRunningOnly: vi.fn(),
  databases: [],
  loadDatabases: vi.fn(),
  databasesLoading: false,
  payload: {
    engine: 'mysql',
    capability: {
      supported: true,
      canCancelQuery: true,
      canTerminateSession: true,
      terminateTarget: 'sessionId',
    },
    sessions,
  },
  loading: false,
  error: '',
  scopeRevision: 0,
  refresh: vi.fn(async () => true),
  executeAction: vi.fn(async () => ({ success: true })),
  executeActionBatch: vi.fn(async () => ({
    total: 0,
    succeeded: 0,
    failed: 0,
    results: [],
  })),
  ...overrides,
});

const buildLockWaits = () => ({
  payload: null,
  loading: false,
  error: '',
  autoRefresh: false,
  setAutoRefresh: vi.fn(),
  refresh: vi.fn(async () => true),
});

const render = (): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<SessionWorkbench tab={{ connectionId: 'c1', dbName: '' }} isActive />);
  });
  return renderer;
};

describe('SessionWorkbench running-only shortcut', () => {
  beforeEach(() => {
    harness.toolbarProps = null;
    harness.tableProps = null;
    harness.lockPanelProps = null;
    harness.lockWaits = buildLockWaits();
    harness.batchOpen.mockReset();
  });

  it('drives the shared workbench state from the toolbar checkbox', () => {
    harness.workbench = buildWorkbench(false);
    render();

    expect(harness.toolbarProps.runningOnly).toBe(false);
    harness.toolbarProps.onRunningOnlyChange(true);
    expect(harness.workbench.setRunningOnly).toHaveBeenCalledWith(true);
  });

  it('shows only executing sessions once the shortcut is on', () => {
    harness.workbench = buildWorkbench(true);
    render();

    expect(harness.toolbarProps.runningOnly).toBe(true);
    expect(harness.tableProps.sessions.map((session: { key: string }) => session.key)).toEqual(['running']);
  });

  it('keeps suspended requests while hiding idle sessions', () => {
    harness.workbench = buildWorkbench(true, {
      payload: {
        engine: 'sqlserver',
        capability: {
          supported: true,
          canCancelQuery: false,
          canTerminateSession: true,
          terminateTarget: 'sessionId',
        },
        sessions: [
          {
            key: 'suspended',
            sessionId: '1',
            state: 'suspended',
            statement: 'SELECT 1',
            databaseOrTenant: 'shop',
          },
          {
            key: 'idle',
            sessionId: '2',
            state: 'sleeping',
            statement: '',
            databaseOrTenant: 'shop',
          },
        ],
      },
    });
    render();

    expect(harness.tableProps.sessions.map((session: { key: string }) => session.key)).toEqual(['suspended']);
  });

  it('narrows rows to the selected database before applying text and run filters', () => {
    harness.workbench = buildWorkbench(true, {
      databaseName: 'shop',
      filter: 'SELECT',
      payload: {
        engine: 'mysql',
        capability: {
          supported: true,
          canCancelQuery: true,
          canTerminateSession: true,
          terminateTarget: 'sessionId',
        },
        sessions: [
          {
            key: 'shop-query',
            sessionId: '1',
            state: 'Query',
            statement: 'SELECT 1',
            databaseOrTenant: 'shop',
          },
          {
            key: 'shop-idle',
            sessionId: '2',
            state: 'Sleep',
            statement: 'SELECT 2',
            databaseOrTenant: 'shop',
          },
          {
            key: 'archive-query',
            sessionId: '3',
            state: 'Query',
            statement: 'SELECT 3',
            databaseOrTenant: 'archive',
          },
        ],
      },
    });
    render();

    expect(harness.tableProps.sessions.map((session: { key: string }) => session.key))
      .toEqual(['shop-query']);
  });

  it('does not apply a stale scope value that is absent from the database picker', () => {
    harness.workbench = buildWorkbench(false, {
      databaseName: 'service-name',
      databases: ['archive', 'shop'],
      payload: {
        engine: 'mysql',
        capability: {
          supported: true,
          canCancelQuery: true,
          canTerminateSession: true,
          terminateTarget: 'sessionId',
        },
        sessions: [
          { key: 'shop', sessionId: '1', state: 'Query', databaseOrTenant: 'shop' },
          { key: 'archive', sessionId: '2', state: 'Sleep', databaseOrTenant: 'archive' },
        ],
      },
    });
    render();

    expect(harness.tableProps.sessions.map((session: { key: string }) => session.key))
      .toEqual(['shop', 'archive']);
  });

  it('enables bulk termination only for an active filter and snapshots eligible rows', () => {
    harness.workbench = buildWorkbench(false, {
      filter: 'shop',
      payload: {
        engine: 'mysql',
        capability: {
          supported: true,
          canCancelQuery: true,
          canTerminateSession: true,
          terminateTarget: 'sessionId',
        },
        sessions: [
          ...sessions.map((item) => ({ ...item, databaseOrTenant: 'shop' })),
          {
            key: 'daemon',
            sessionId: '3',
            state: 'Daemon',
            statement: 'SELECT 1',
            databaseOrTenant: 'shop',
          },
        ],
      },
    });
    render();

    expect(harness.toolbarProps.batchTerminateCount).toBe(2);
    expect(harness.toolbarProps.batchTerminateDisabled).toBe(false);
    harness.toolbarProps.onBatchTerminate();
    expect(harness.batchOpen).toHaveBeenCalledWith({
      sessions: [
        expect.objectContaining({ key: 'running' }),
        expect.objectContaining({ key: 'idle' }),
      ],
      skippedCount: 1,
      totalVisible: 3,
    });
  });

  it('keeps bulk termination disabled until a filter is active', () => {
    harness.workbench = buildWorkbench(false);
    render();

    expect(harness.toolbarProps.batchTerminateCount).toBe(2);
    expect(harness.toolbarProps.batchTerminateDisabled).toBe(true);
    expect(harness.toolbarProps.batchTerminateHint).toBe('session_workbench.batch.requires_filter');
  });
});

describe('SessionWorkbench lock-wait view', () => {
  beforeEach(() => {
    harness.workbench = buildWorkbench(false);
    harness.lockWaits = buildLockWaits();
    harness.lockPanelProps = null;
  });

  it('loads lock waits only once the view is opened, for the same connection scope', () => {
    render();
    expect(harness.lockWaitOptions).toMatchObject({ enabled: false, databaseName: 'shop', active: true });
    expect(harness.lockPanelProps).toBeNull();

    act(() => harness.switchProps.onChange('lockWaits'));

    expect(harness.lockWaitOptions.enabled).toBe(true);
    expect(harness.lockWaitOptions.connection).toBe(harness.workbench.selectedConnection);
    expect(harness.lockPanelProps.sessionCapability).toBe(harness.workbench.payload.capability);
    // The text filter only narrows the session list.
    expect(harness.toolbarProps.showSessionFilters).toBe(false);
    harness.toolbarProps.onRefresh();
    expect(harness.lockWaits.refresh).toHaveBeenCalledTimes(1);
    expect(harness.workbench.refresh).not.toHaveBeenCalled();
  });

  it('re-reads blocking chains after a blocker is terminated from the lock view', async () => {
    render();
    act(() => harness.switchProps.onChange('lockWaits'));

    const request = { action: 'terminateSession', sessionId: '10' };
    await act(async () => {
      await harness.dialogOptions.workbench.executeAction(request);
    });

    expect(harness.workbench.executeAction).toHaveBeenCalledWith(request);
    expect(harness.lockWaits.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not re-read lock waits for actions taken from the session list', async () => {
    render();
    await act(async () => {
      await harness.dialogOptions.workbench.executeAction({ action: 'cancelQuery', sessionId: '1' });
    });
    expect(harness.lockWaits.refresh).not.toHaveBeenCalled();
  });
});
