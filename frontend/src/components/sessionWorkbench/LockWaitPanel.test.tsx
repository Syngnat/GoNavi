import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { LockWaitPayload } from './lockWaitModel';

const panel = vi.hoisted(() => ({ tableProps: null as any, emptyDescriptions: [] as string[] }));

vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      params ? `${key}(${Object.values(params).join(',')})` : key
    ),
  }),
}));

vi.mock('antd', () => ({
  Alert: ({ message }: any) => <div data-alert="true">{message}</div>,
  Empty: ({ description }: any) => {
    panel.emptyDescriptions.push(description);
    return <div data-empty="true">{description}</div>;
  },
  Spin: () => <div data-spin="true" />,
  Switch: (props: any) => <input type="checkbox" data-auto-refresh="true" checked={props.checked} onChange={() => props.onChange(!props.checked)} />,
  Table: (props: any) => {
    panel.tableProps = props;
    return <div data-lock-table="true" />;
  },
  Tag: ({ children }: any) => <span>{children}</span>,
  Tooltip: ({ children }: any) => <span>{children}</span>,
  Typography: { Text: ({ children }: any) => <span>{children}</span> },
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

import LockWaitPanel, { type LockWaitPanelProps } from './LockWaitPanel';

const capability = { supported: true, canCancelQuery: true, canTerminateSession: true, cancelTarget: 'sessionId', terminateTarget: 'sessionId' };

const payload = (waits: LockWaitPayload['waits'], supported = true, reasonCode?: string): LockWaitPayload => ({
  engine: 'mysql',
  capability: { supported, reasonCode },
  waits,
  scopedDatabase: '',
});

const render = (props: Partial<LockWaitPanelProps>): ReactTestRenderer => {
  panel.tableProps = null;
  panel.emptyDescriptions = [];
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LockWaitPanel
        hasConnection
        payload={null}
        loading={false}
        error=""
        sessionCapability={capability}
        autoRefresh={false}
        onAutoRefreshChange={vi.fn()}
        onAction={vi.fn()}
        onRetry={vi.fn()}
        {...props}
      />,
    );
  });
  return renderer;
};

describe('LockWaitPanel', () => {
  it('states when an engine cannot report lock waits', () => {
    render({ payload: payload([], false, 'unsupported') });
    expect(new Set(panel.emptyDescriptions)).toEqual(new Set(['session_workbench.lock.empty.unsupported']));
    render({ payload: payload([], false, 'not_applicable') });
    expect(new Set(panel.emptyDescriptions)).toEqual(new Set(['session_workbench.lock.empty.not_applicable']));
  });

  it('says nobody is waiting instead of rendering an empty table', () => {
    const renderer = render({ payload: payload([]) });
    expect(new Set(panel.emptyDescriptions)).toEqual(new Set(['session_workbench.lock.empty.none']));
    expect(panel.tableProps).toBeNull();
    // Auto-refresh stays reachable so the user can wait for a wait to appear.
    expect(renderer.root.findAll((node) => node.props['data-auto-refresh'] === 'true')).toHaveLength(1);
  });

  it('renders blocking chains expanded with the root blocker first', () => {
    const renderer = render({
      payload: payload([
        { key: 'a', waitingSessionId: '11', blockingSessionId: '10', blockingState: 'Sleep', waitDurationMs: 8000, objectName: 'shop.orders', lockType: 'RECORD', lockMode: 'X' },
        { key: 'b', waitingSessionId: '12', blockingSessionId: '11', waitDurationMs: 3000, lockType: 'METADATA' },
      ]),
    });
    const rows = panel.tableProps.dataSource;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'root', blockedCount: 2, idleHolder: true });
    expect(panel.tableProps.expandable.expandedRowKeys).toEqual(
      expect.arrayContaining([rows[0].key, rows[0].children[0].key]),
    );
    const summary = renderer.root.findAll((node) => typeof node.props.className === 'string'
      && node.props.className.startsWith('gn-lock-wait-summary-item'));
    expect(summary.map((node) => node.children.join(''))).toEqual([
      'session_workbench.lock.summary.waiting(2)',
      'session_workbench.lock.summary.roots(1)',
      expect.stringContaining('session_workbench.lock.summary.longest'),
    ]);
  });

  it('offers the shared session actions on the blocker row', () => {
    const onAction = vi.fn();
    render({
      onAction,
      payload: payload([{ key: 'a', waitingSessionId: '11', blockingSessionId: '10' }]),
    });
    const actionsColumn = panel.tableProps.columns.find((column: any) => column.key === 'actions');
    let cell!: ReactTestRenderer;
    act(() => {
      cell = create(actionsColumn.render(undefined, panel.tableProps.dataSource[0]));
    });
    const button = cell.root.findByType('button');
    act(() => button.props.onClick());
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ sessionId: '10' }), 'cancelQuery');
  });

  it('shows a retryable error', () => {
    const onRetry = vi.fn();
    const renderer = render({ error: 'list_failed', onRetry });
    expect(renderer.root.findByProps({ 'data-alert': 'true' }).props.children).toBe('session_workbench.lock.error.list_failed');
  });
});
