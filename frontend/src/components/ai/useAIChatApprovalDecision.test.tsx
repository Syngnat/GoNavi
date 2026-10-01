import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AIApprovalScope } from './aiAutoApproval';
import type { AIRunApprovalState } from './aiRunEventProjection';
import { useAIChatApprovalDecision } from './useAIChatApprovalDecision';

const approval: AIRunApprovalState = {
  runId: 'run-1',
  sessionId: 'session-1',
  approvalId: 'approval-1',
  callId: 'call-1',
  decision: 'pending',
  toolName: 'execute_sql',
  effect: 'side_effect',
  argsHash: 'hash-1',
  revision: 3,
};

type Decide = ReturnType<typeof useAIChatApprovalDecision>;

const mount = async (handleRunControl: Parameters<typeof useAIChatApprovalDecision>[0]): Promise<Decide> => {
  let decide: Decide | undefined;
  const Probe = () => {
    decide = useAIChatApprovalDecision(handleRunControl);
    return null;
  };
  await act(async () => {
    create(<Probe />);
  });
  return decide!;
};

const stubService = (service: Record<string, unknown>) => {
  vi.stubGlobal('window', { go: { aiservice: { Service: service } } });
};

describe('useAIChatApprovalDecision', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('approves once without storing anything', async () => {
    const AISetSessionAutoApproval = vi.fn();
    stubService({ AISetSessionAutoApproval });
    const handleRunControl = vi.fn().mockResolvedValue(undefined);
    const decide = await mount(handleRunControl);

    await act(async () => decide(approval, 'approved'));

    expect(AISetSessionAutoApproval).not.toHaveBeenCalled();
    expect(handleRunControl).toHaveBeenCalledWith('run-1', 'approve', {
      approvalId: 'approval-1',
      callId: 'call-1',
      argsHash: 'hash-1',
      busyKey: 'run-1:approve:approval-1',
    });
  });

  it.each([
    ['session' as AIApprovalScope, 'AISetSessionAutoApproval', ['session-1', true]],
    ['global' as AIApprovalScope, 'AISetGlobalAutoApproval', [true]],
  ])('stores the %s choice before approving the waiting call', async (scope, method, args) => {
    const order: string[] = [];
    const stored = vi.fn(async () => { order.push('stored'); return { global: false, sessionIds: [] }; });
    stubService({ [method]: stored });
    const handleRunControl = vi.fn(async () => { order.push('approved'); });
    const decide = await mount(handleRunControl);

    await act(async () => decide(approval, 'approved', scope));

    expect(stored).toHaveBeenCalledWith(...args);
    expect(order).toEqual(['stored', 'approved']);
  });

  it('still approves this call when the always-choice cannot be stored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubService({ AISetGlobalAutoApproval: vi.fn().mockRejectedValue(new Error('disk full')) });
    const handleRunControl = vi.fn().mockResolvedValue(undefined);
    const decide = await mount(handleRunControl);

    await act(async () => decide(approval, 'approved', 'global'));

    expect(handleRunControl).toHaveBeenCalledWith('run-1', 'approve', expect.objectContaining({ approvalId: 'approval-1' }));
  });

  it('never stores an always-choice when the call is denied', async () => {
    const AISetGlobalAutoApproval = vi.fn();
    stubService({ AISetGlobalAutoApproval });
    const handleRunControl = vi.fn().mockResolvedValue(undefined);
    const decide = await mount(handleRunControl);

    await act(async () => decide(approval, 'denied', 'global'));

    expect(AISetGlobalAutoApproval).not.toHaveBeenCalled();
    expect(handleRunControl).toHaveBeenCalledWith('run-1', 'deny', expect.objectContaining({ busyKey: 'run-1:deny:approval-1' }));
  });
});
