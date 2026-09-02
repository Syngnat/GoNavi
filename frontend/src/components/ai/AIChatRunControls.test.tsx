import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIChatRunControls from './AIChatRunControls';
import type { AIRunApprovalState, AIRunRecoveryState } from './aiRunEventProjection';

vi.mock('antd', async () => {
  const React = await import('react');
  const Button = ({
    children,
    icon,
    onClick,
    ...props
  }: {
    children?: React.ReactNode;
    icon?: React.ReactNode;
    onClick?: () => void;
    [key: string]: unknown;
  }) => React.createElement(
    'button',
    { type: 'button', ...props, onClick },
    icon,
    children,
  );
  const Tag = ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
    React.createElement('span', props, children);
  const Tooltip = ({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) =>
    React.createElement('span', { 'data-tooltip-title': title }, children);
  return { Button, Tag, Tooltip };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const makeIcon = (name: string) => () => React.createElement('span', { 'data-icon': name });
  return {
    CheckCircleOutlined: makeIcon('check-circle'),
    CheckOutlined: makeIcon('check'),
    CloseCircleOutlined: makeIcon('close-circle'),
    CloudSyncOutlined: makeIcon('cloud-sync'),
    ExclamationCircleOutlined: makeIcon('exclamation-circle'),
    ReloadOutlined: makeIcon('reload'),
    StopOutlined: makeIcon('stop'),
  };
});

const approval: AIRunApprovalState = {
  runId: 'run-approval',
  sessionId: 'session-1',
  approvalId: 'approval-1',
  callId: 'call-1',
  decision: 'pending',
  toolName: 'execute_sql',
  effect: 'side_effect',
  argsHash: 'hash-1',
  summary: 'Add one audit entry',
  revision: 7,
};

const recovery: AIRunRecoveryState = {
  runId: 'run-recovery',
  sessionId: 'session-1',
  callId: 'call-2',
  toolName: 'execute_sql',
  effect: 'side_effect_unknown',
  status: 'unknown',
  errorCode: 'outcome_unknown',
  reason: 'The external operation may have committed.',
  revision: 12,
};

const workspace = {
  runId: 'run-workspace',
  sessionId: 'session-1',
  revision: 15,
};

const theme = buildOverlayWorkbenchTheme(false);

const renderControls = (
  overrides: Partial<React.ComponentProps<typeof AIChatRunControls>> = {},
): ReactTestRenderer => create(
  <AIChatRunControls
    approvals={[approval]}
    recoveries={[recovery]}
    waitingWorkspaces={[workspace]}
    darkMode={false}
    textColor="#111"
    mutedColor="#667085"
    overlayTheme={theme}
    onApprovalDecision={() => undefined}
    onRecoveryAction={() => undefined}
    onWorkspaceAction={() => undefined}
    {...overrides}
  />,
);

const textContent = (node: unknown): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'object') {
    const value = node as { children?: unknown };
    return textContent(value.children);
  }
  return '';
};

describe('AIChatRunControls', () => {
  it('renders approval, recovery, and workspace cards with their actions', () => {
    const renderer = renderControls();
    const markup = renderer.toJSON();
    const text = textContent(markup);

    expect(renderer.root.findByProps({ 'aria-live': 'polite' })).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-testid': 'ai-run-approval-approval-1' })).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-testid': 'ai-run-recovery-run-recovery' })).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-testid': 'ai-run-workspace-run-workspace' })).toBeTruthy();
    expect(text).toContain('Approval required');
    expect(text).toContain('Recovery required');
    expect(text).toContain('execute_sql');
    expect(text).toContain('Add one audit entry');
    expect(text).toContain('Approve');
    expect(text).toContain('Deny');
    expect(text).toContain('Retry');
    expect(text).toContain('Mark completed');
    expect(text).toContain('Abort');
    expect(text).toContain('Workspace unavailable');
    expect(text).toContain('Use saved snapshot');
  });

  it('routes approval, recovery, and workspace actions to their exact run records', async () => {
    const onApprovalDecision = vi.fn();
    const onRecoveryAction = vi.fn();
    const onWorkspaceAction = vi.fn();
    const renderer = renderControls({ onApprovalDecision, onRecoveryAction, onWorkspaceAction });
    const buttons = renderer.root.findAllByType('button');

    await act(async () => {
      buttons[0].props.onClick();
      buttons[1].props.onClick();
      buttons[2].props.onClick();
      buttons[3].props.onClick();
      buttons[4].props.onClick();
      buttons[5].props.onClick();
    });

    expect(onApprovalDecision).toHaveBeenNthCalledWith(1, approval, 'approved');
    expect(onApprovalDecision).toHaveBeenNthCalledWith(2, approval, 'denied');
    expect(onRecoveryAction).toHaveBeenNthCalledWith(1, recovery, 'recover');
    expect(onRecoveryAction).toHaveBeenNthCalledWith(2, recovery, 'mark_completed');
    expect(onRecoveryAction).toHaveBeenNthCalledWith(3, recovery, 'abort_recovery');
    expect(onWorkspaceAction).toHaveBeenCalledWith(workspace, 'use_stale_workspace');
  });

  it('renders only the server summary and never raw approval arguments', () => {
    const rawArguments = { sql: 'INSERT INTO audit_log VALUES (super_secret)' };
    const renderer = renderControls({
      approvals: [{ ...approval, arguments: rawArguments } as unknown as AIRunApprovalState],
    });
    const text = textContent(renderer.toJSON());
    expect(text).toContain('Add one audit entry');
    expect(text).not.toContain('INSERT INTO audit_log');

    renderer.update(
      <AIChatRunControls
        approvals={[]}
        recoveries={[]}
        waitingWorkspaces={[]}
        darkMode={false}
        textColor="#111"
        mutedColor="#667085"
        overlayTheme={theme}
        onApprovalDecision={() => undefined}
        onRecoveryAction={() => undefined}
        onWorkspaceAction={() => undefined}
      />,
    );
    expect(renderer.toJSON()).toBeNull();
  });
});
