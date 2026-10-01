import React, { forwardRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('antd', () => {
  const Button = forwardRef<HTMLButtonElement, any>(({ children, ...props }, ref) => (
    <button ref={ref} data-label={typeof children === 'string' ? children : ''} {...props}>
      {children}
    </button>
  ));
  const Checkbox = ({ checked, onChange, children }: any) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
      />
      {children}
    </label>
  );
  const Modal = ({ open, title, children }: any) => open ? (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ) : null;
  const Space = ({ children }: any) => <div>{children}</div>;
  const Typography = {
    Text: ({ children }: any) => <span>{children}</span>,
  };
  return {
    Button,
    Checkbox,
    Divider: () => <hr />,
    Modal,
    Space,
    Typography,
  };
});

import SessionConfirmModal from './SessionConfirmModal';

const session = {
  key: 'mysql:42',
  databaseOrTenant: 'analytics',
  sessionId: '42',
  statement: 'SELECT * FROM orders WHERE customer_id = 42',
};

const capability = {
  supported: true,
  canCancelQuery: false,
  canTerminateSession: true,
  terminateTarget: 'sessionId' as const,
};

const renderModal = (production: boolean): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SessionConfirmModal
        open
        action="terminateSession"
        session={{
          ...session,
          statement: `${session.statement} ${'AND customer_id = 42 '.repeat(16)}`,
        }}
        capability={capability}
        connectionName="Production DB"
        production={production}
        loading={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
  });
  return renderer;
};

const buttonByLabel = (renderer: ReactTestRenderer, label: string) => (
  renderer.root.findByProps({ 'data-label': label })
);

describe('SessionConfirmModal', () => {
  it('keeps production termination disabled until the explicit acknowledgement', () => {
    const renderer = renderModal(true);
    const submit = buttonByLabel(renderer, 'session_workbench.confirm.submit_terminate');
    expect(submit.props.disabled).toBe(true);

    const checkbox = renderer.root.findByType('input');
    act(() => checkbox.props.onChange({ target: { checked: true } }));
    expect(buttonByLabel(renderer, 'session_workbench.confirm.submit_terminate').props.disabled).toBe(false);
  });

  it('blocks Enter and only invokes the dangerous action through the button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <SessionConfirmModal
          open
          action="cancelQuery"
          session={{ ...session, queryId: 'query-42' }}
          capability={{ ...capability, canCancelQuery: true, cancelTarget: 'queryId' }}
          connectionName="Test DB"
          production={false}
          loading={false}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />,
      );
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const content = renderer.root.findByProps({ className: 'gn-session-workbench-confirm-content' });
    act(() => content.props.onKeyDown({ key: 'Enter', preventDefault, stopPropagation }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => buttonByLabel(renderer, 'session_workbench.confirm.submit_cancel').props.onClick());
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('renders a truncated statement with an explicit expand/collapse control', () => {
    const renderer = renderModal(false);
    const expand = buttonByLabel(renderer, 'session_workbench.confirm.expand');
    expect(JSON.stringify(renderer.toJSON())).toContain('…');

    act(() => expand.props.onClick());
    expect(buttonByLabel(renderer, 'session_workbench.confirm.collapse')).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain('customer_id = 42');
  });

  it('shows the row tenant and Oracle composite target in the blocker', () => {
    const renderer = renderModal(false);
    // Re-render with the Oracle adapter contract; the confirmation target
    // must match the exact SID,SERIAL,@INST_ID command target.
    act(() => {
      renderer.update(
        <SessionConfirmModal
          open
          action="terminateSession"
          session={{
            ...session,
            databaseOrTenant: 'tenant-from-row',
            sessionId: '7',
            instanceId: '2',
            serialNumber: '3',
          }}
          capability={{
            supported: true,
            canCancelQuery: false,
            canTerminateSession: true,
            terminateTarget: 'sessionId',
            terminateRequiresInstanceAndSerial: true,
          }}
          connectionName="Oracle DB"
          production={false}
          loading={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
    });
    const text = renderer.root.findAllByType('span').map((node) => node.children.join(' ')).join(' ');
    expect(text).toContain('tenant-from-row');
    expect(text).toContain('7,3,@2');
  });
});
