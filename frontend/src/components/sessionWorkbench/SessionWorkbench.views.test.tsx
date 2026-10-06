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
vi.mock('./SessionConfirmModal', () => ({ default: () => null }));

import SessionWorkbench from './SessionWorkbench';

const sessions = [
  { key: 'running', sessionId: '1', state: 'Query', statement: 'SELECT SLEEP(30)' },
  { key: 'idle', sessionId: '2', state: 'Sleep', statement: '' },
];

const buildWorkbench = (runningOnly: boolean) => ({
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
    capability: { supported: true, canCancelQuery: true, canTerminateSession: true },
    sessions,
  },
  loading: false,
  error: '',
  scopeRevision: 0,
  refresh: vi.fn(async () => true),
  executeAction: vi.fn(async () => ({ success: true })),
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
