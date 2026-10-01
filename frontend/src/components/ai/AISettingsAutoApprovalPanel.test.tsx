import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AISettingsAutoApprovalPanel from './AISettingsAutoApprovalPanel';

vi.mock('antd', async () => {
  const React = await import('react');
  const Switch = ({ checked, disabled, onChange }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (checked: boolean) => void;
  }) => React.createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': Boolean(checked),
    disabled,
    onClick: () => onChange?.(!checked),
  });
  const Button = ({ children, onClick, disabled }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => React.createElement('button', { type: 'button', onClick, disabled }, children);
  const Alert = ({ message, type }: { message?: React.ReactNode; type?: string }) =>
    React.createElement('div', { role: 'alert', 'data-type': type }, message);
  return { Alert, Button, Switch };
});

const theme = buildOverlayWorkbenchTheme(false);

const textOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());

const mount = async (): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<AISettingsAutoApprovalPanel overlayTheme={theme} cardBorder="#ddd" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
};

describe('AISettingsAutoApprovalPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows nothing when the Go service is unreachable', async () => {
    vi.stubGlobal('window', {});
    const renderer = await mount();
    expect(renderer.toJSON()).toBeNull();
  });

  it('turns the global switch on through the service and warns about it', async () => {
    const AIGetAutoApprovalSettings = vi.fn().mockResolvedValue({ global: false, sessionIds: [] });
    const AISetGlobalAutoApproval = vi.fn().mockResolvedValue({ global: true, sessionIds: [] });
    vi.stubGlobal('window', { go: { aiservice: { Service: { AIGetAutoApprovalSettings, AISetGlobalAutoApproval } } } });
    const renderer = await mount();

    const toggle = renderer.root.findByProps({ role: 'switch' });
    expect(toggle.props['aria-checked']).toBe(false);
    expect(textOf(renderer)).toContain('No session has');
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);

    await act(async () => {
      toggle.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(AISetGlobalAutoApproval).toHaveBeenCalledWith(true);
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);
    expect(renderer.root.findByProps({ role: 'alert' }).props['data-type']).toBe('warning');
  });

  it('lists the granted sessions and revokes them all at once', async () => {
    const AIGetAutoApprovalSettings = vi.fn().mockResolvedValue({ global: false, sessionIds: ['s1', 's2'] });
    const AIClearSessionAutoApprovals = vi.fn().mockResolvedValue({ global: false, sessionIds: [] });
    vi.stubGlobal('window', { go: { aiservice: { Service: { AIGetAutoApprovalSettings, AIClearSessionAutoApprovals } } } });
    const renderer = await mount();

    expect(textOf(renderer)).toContain('is on for 2 session(s)');
    const clear = renderer.root.findAllByType('button')
      .find((button) => String(JSON.stringify(button.props.children)).includes('Revoke all'));
    expect(clear).toBeTruthy();

    await act(async () => {
      clear!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(AIClearSessionAutoApprovals).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).toContain('No session has');
  });

  it('reports a failed save without changing the switch', async () => {
    const AIGetAutoApprovalSettings = vi.fn().mockResolvedValue({ global: false, sessionIds: [] });
    const AISetGlobalAutoApproval = vi.fn().mockRejectedValue(new Error('disk full'));
    vi.stubGlobal('window', { go: { aiservice: { Service: { AIGetAutoApprovalSettings, AISetGlobalAutoApproval } } } });
    const renderer = await mount();

    await act(async () => {
      renderer.root.findByProps({ role: 'switch' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(false);
    expect(renderer.root.findByProps({ role: 'alert' }).props['data-type']).toBe('error');
  });
});
