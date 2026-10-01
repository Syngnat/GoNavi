import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../i18n/provider', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('antd', () => ({
  Modal: ({ open, title, children }: any) => open ? (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ) : null,
}));

import SessionActionChooser from './SessionActionChooser';

const session = { key: 'mysql:42', sessionId: '42', statement: 'SELECT 1' };
const capability = {
  supported: true,
  canCancelQuery: true,
  canTerminateSession: true,
  cancelTarget: 'sessionId' as const,
  terminateTarget: 'sessionId' as const,
};

describe('SessionActionChooser', () => {
  it('lists each available action with its helper text and reports the pick', () => {
    const onSelect = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <SessionActionChooser
          open
          session={session}
          capability={capability}
          onSelect={onSelect}
          onCancel={vi.fn()}
        />,
      );
    });

    const options = renderer.root.findAllByType('button');
    expect(options).toHaveLength(2);
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('session_workbench.action.cancel_helper');
    expect(json).toContain('session_workbench.action.terminate_helper');

    act(() => options[1].props.onClick());
    expect(onSelect).toHaveBeenCalledWith('terminateSession');
  });

  it('renders nothing without a session', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <SessionActionChooser
          open
          session={null}
          capability={capability}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
