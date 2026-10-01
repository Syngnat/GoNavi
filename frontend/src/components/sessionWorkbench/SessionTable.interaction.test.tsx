import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SessionCapability } from './sessionWorkbenchModel';

const tableState = vi.hoisted(() => ({
  props: null as any,
}));

vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('antd', () => {
  const Button = ({ children, ...props }: any) => <button {...props}>{children}</button>;
  const Space = ({ children }: any) => <div>{children}</div>;
  const Tag = ({ children }: any) => <span>{children}</span>;
  const Tooltip = ({ children }: any) => <span>{children}</span>;
  const Typography = { Text: ({ children }: any) => <span>{children}</span> };
  const Table = (props: any) => {
    tableState.props = props;
    return <div data-session-table="true" />;
  };
  return { Button, Space, Table, Tag, Tooltip, Typography };
});

import SessionTable from './SessionTable';

const session = {
  key: 'mysql:42:query-42',
  databaseOrTenant: 'analytics',
  sessionId: '42',
  queryId: 'query-42',
  statement: 'SELECT 1',
};

const dualCapability = {
  supported: true,
  canCancelQuery: true,
  canTerminateSession: true,
  cancelTarget: 'queryId' as const,
  terminateTarget: 'sessionId' as const,
};

const renderActions = (
  capability: SessionCapability = dualCapability,
): ReactTestRenderer => {
  tableState.props = null;
  act(() => {
    create(
      <SessionTable
        sessions={[session]}
        capability={capability}
        loading={false}
        onAction={vi.fn()}
      />,
    );
  });
  const column = tableState.props.columns.find((item: any) => item.key === 'actions');
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(column.render(undefined, session));
  });
  return renderer;
};

describe('SessionTable action entry', () => {
  it('routes dual-capability rows through one explicit chooser button', () => {
    const renderer = renderActions();
    const buttons = renderer.root.findAllByType('button');

    expect(buttons).toHaveLength(1);
    expect(buttons[0].children.join('')).toBe('session_workbench.action.manage');
  });

  it('keeps a single-capability row on its direct action button', () => {
    const renderer = renderActions({
      supported: true,
      canCancelQuery: false,
      canTerminateSession: true,
      terminateTarget: 'sessionId',
    });
    const buttons = renderer.root.findAllByType('button');

    expect(buttons).toHaveLength(1);
    expect(buttons[0].children.join('')).toBe('session_workbench.action.terminate_session');
  });
});
