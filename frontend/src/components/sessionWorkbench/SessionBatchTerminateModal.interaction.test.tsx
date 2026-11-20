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
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  );
  const Modal = ({ open, title, children }: any) => open ? (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ) : null;
  const Typography = {
    Text: ({ children }: any) => <span>{children}</span>,
    Paragraph: ({ children }: any) => <p>{children}</p>,
  };
  return {
    Button,
    Checkbox,
    Divider: () => <hr />,
    Modal,
    Space: ({ children }: any) => <div>{children}</div>,
    Typography,
  };
});

import SessionBatchTerminateModal from './SessionBatchTerminateModal';

const capability = {
  supported: true,
  canCancelQuery: false,
  canTerminateSession: true,
  terminateTarget: 'sessionId' as const,
};

const sessions = [
  { key: 'db:1', sessionId: '1', statement: 'SELECT SLEEP(30)', state: 'Query' },
  { key: 'db:2', sessionId: '2', statement: 'SELECT SLEEP(60)', state: 'Query' },
];

const renderModal = (production: boolean, onConfirm = vi.fn()): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SessionBatchTerminateModal
        open
        sessions={sessions}
        skippedCount={1}
        totalVisible={3}
        capability={capability}
        connectionName="Production DB"
        databaseName="shop"
        production={production}
        loading={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
  });
  return renderer;
};

const submitButton = (renderer: ReactTestRenderer) => (
  renderer.root.findByProps({ 'data-label': 'session_workbench.batch.submit' })
);

describe('SessionBatchTerminateModal', () => {
  it('requires the production acknowledgement before bulk termination', () => {
    const renderer = renderModal(true);
    expect(submitButton(renderer).props.disabled).toBe(true);

    const checkbox = renderer.root.findByType('input');
    act(() => checkbox.props.onChange({ target: { checked: true } }));
    expect(submitButton(renderer).props.disabled).toBe(false);
  });

  it('blocks Enter and only submits through the dangerous button', () => {
    const onConfirm = vi.fn();
    const renderer = renderModal(false, onConfirm);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    const content = renderer.root.findByProps({ className: 'gn-session-workbench-confirm-content' });
    act(() => content.props.onKeyDown({ key: 'Enter', preventDefault, stopPropagation }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => submitButton(renderer).props.onClick());
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
