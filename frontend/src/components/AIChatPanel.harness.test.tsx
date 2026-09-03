import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '../store';
import type { AIChatMessage } from '../types';
import { buildOverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import AIChatPanel from './AIChatPanel';

const harnessMock = vi.hoisted(() => {
  const submitAgentInput = vi.fn();
  const getRunPolicy = vi.fn();
  const controlAgentRun = vi.fn();
  const readAgentRun = vi.fn();
  const readAgentSession = vi.fn();
  const mutateAgentSession = vi.fn();
  return {
    submitAgentInput,
    getRunPolicy,
    controlAgentRun,
    readAgentRun,
    readAgentSession,
    mutateAgentSession,
    service: {
      AISubmitAgentInput: submitAgentInput,
      AIGetRunPolicy: getRunPolicy,
      AIControlAgentRun: controlAgentRun,
      AIReadAgentRun: readAgentRun,
      AIReadAgentSession: readAgentSession,
      AIMutateAgentSession: mutateAgentSession,
    },
    inputProps: undefined as Record<string, any> | undefined,
    conversationProps: undefined as Record<string, any> | undefined,
    runControlsProps: undefined as Record<string, any> | undefined,
    runSubscriptionProps: undefined as Record<string, any> | undefined,
    session: {
      sid: 'source-session',
      messages: [] as any[],
      orderedAISessions: [{
        id: 'source-session',
        title: 'Source',
        revision: 42,
        updatedAt: 1,
      }],
    },
  };
});

vi.mock('./ai/AIChatHeader', () => ({ AIChatHeader: () => null }));
vi.mock('./ai/AIHistoryDrawer', () => ({ AIHistoryDrawer: () => null }));
vi.mock('./ai/AIChatRunControls', () => ({
  default: (props: Record<string, any>) => {
    harnessMock.runControlsProps = props;
    return null;
  },
}));
vi.mock('./ai/AIChatInput', () => ({
  AIChatInput: (props: Record<string, any>) => {
    harnessMock.inputProps = props;
    return React.createElement('button', { type: 'button', onClick: props.onSend });
  },
}));
vi.mock('./ai/AIChatPanelConversationView', () => ({
  default: (props: Record<string, any>) => {
    harnessMock.conversationProps = props;
    return null;
  },
}));
vi.mock('./ai/useAIChatRunEventSubscription', () => ({
  useAIChatRunEventSubscription: (props: Record<string, any>) => {
    harnessMock.runSubscriptionProps = props;
  },
}));
vi.mock('./ai/aiRunHarnessClient', () => ({
  controlAgentRun: harnessMock.controlAgentRun,
  createRunPendingMessageId: (runId: string) => `agent-run-${runId}-pending`,
  getAIRunHarnessService: () => harnessMock.service,
  getRunPolicy: harnessMock.getRunPolicy,
  hasAIRunHarness: () => true,
  mergeAIChatSessionMessages: (durable: unknown[]) => durable,
  mutateAgentSession: harnessMock.mutateAgentSession,
  readAgentRun: harnessMock.readAgentRun,
  readAgentSession: harnessMock.readAgentSession,
  submitAgentInput: harnessMock.submitAgentInput,
  toAIChatMessages: () => [],
}));
vi.mock('./ai/useAIWorkspaceSnapshot', () => ({
  getAIWorkspaceSourceInstanceID: () => 'desktop-test-instance',
}));
vi.mock('../utils/connectionRpcConfig', () => ({ buildRpcConnectionConfig: () => undefined }));
vi.mock('../utils/aiComposerNotice', () => ({ buildAIComposerNotice: () => null }));
vi.mock('../utils/aiChatSendShortcut', () => ({ consumeAIChatSendShortcutOnKeyDown: () => undefined }));
vi.mock('../utils/aiChatRuntime', () => ({ getDynamicMaxContextChars: () => 100_000 }));
vi.mock('../utils/shortcuts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/shortcuts')>();
  return {
    ...actual,
    getShortcutPlatform: () => 'windows',
    resolveShortcutBinding: () => ({ combo: 'Ctrl+Enter', enabled: true }),
  };
});
vi.mock('../utils/appearance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/appearance')>();
  return { ...actual, isMacLikePlatform: () => false };
});
vi.mock('./ai/aiChatPanelDerivedState', () => ({
  buildAIChatInsights: () => [],
  buildAIChatInlineHistorySessions: () => [],
  calculateAIContextUsageChars: () => 0,
  collectAIChatContextTableNames: () => [],
  inferAIChatConnectionContext: () => ({}),
  resolveAIChatPanelMode: (_isV2Ui: boolean, mode: string) => mode,
}));
vi.mock('./ai/aiChatReadiness', () => ({
  buildAIChatReadinessSnapshot: () => ({ status: 'ready' }),
}));
vi.mock('./ai/useAIChatRuntimeResources', () => ({
  useAIChatRuntimeResources: () => ({
    activeProvider: {
      id: 'provider-1',
      type: 'openai',
      model: 'model-1',
      baseUrl: 'https://example.invalid/v1',
    },
    composerNotice: null,
    dynamicModels: ['model-1'],
    fetchDynamicModels: () => undefined,
    handleComposerAction: () => undefined,
    handleModelChange: () => undefined,
    handleOpenSettingsFromPanel: () => undefined,
    loadingModels: false,
  }),
}));
vi.mock('./ai/useAIChatAutoContext', () => ({ useAIChatAutoContext: () => undefined }));
vi.mock('./ai/useAIChatPanelResize', () => ({
  useAIChatPanelResize: () => ({
    ghostRef: { current: null },
    handleResizeStart: () => undefined,
    isResizing: false,
    panelRect: { current: null },
    panelRef: { current: null },
    panelWidth: 380,
  }),
}));
vi.mock('./ai/useAIChatSessionState', () => ({
  useAIChatSessionState: () => harnessMock.session,
}));
vi.mock('../hooks/useWorkbenchTabs', () => ({ useWorkbenchTabs: () => [] }));
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../utils/aiThinkingIntensity', () => ({
  coerceThinkingIntensityForProfile: (value: string) => value,
  defaultThinkingIntensityForProfile: () => 'medium',
  resolveThinkingIntensityProfile: () => ({}),
}));

const originalStore = useStore.getState();

const sourceMessages: AIChatMessage[] = [
  { id: 'user-1', role: 'user', content: 'Original prompt', timestamp: 1 },
  { id: 'assistant-1', role: 'assistant', content: 'Original reply', timestamp: 2 },
];

const renderPanel = (): ReactTestRenderer => create(
  <AIChatPanel
    darkMode={false}
    onClose={() => undefined}
    overlayTheme={buildOverlayWorkbenchTheme(false)}
  />,
);

const submitReceipt = (sessionId = 'branched-session') => ({
  requestId: 'ignored-by-test',
  sessionId,
  runId: 'run-1',
  disposition: 'queued',
  revision: 1,
  state: 'queued',
});

describe('AIChatPanel agent run branch submission', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout,
    });
    harnessMock.inputProps = undefined;
    harnessMock.conversationProps = undefined;
    harnessMock.runControlsProps = undefined;
    harnessMock.runSubscriptionProps = undefined;
    harnessMock.session = {
      sid: 'source-session',
      messages: sourceMessages,
      orderedAISessions: [{
        id: 'source-session',
        title: 'Source',
        revision: 42,
        updatedAt: 1,
      }],
    };
    harnessMock.submitAgentInput.mockReset();
    harnessMock.submitAgentInput.mockResolvedValue(submitReceipt());
    harnessMock.getRunPolicy.mockReset();
    harnessMock.getRunPolicy.mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      policy: { defaultDispatchMode: 'queue' },
    });
    harnessMock.controlAgentRun.mockReset();
    harnessMock.controlAgentRun.mockResolvedValue({ state: 'awaiting_workspace', revision: 13 });
    harnessMock.readAgentRun.mockReset();
    harnessMock.readAgentRun.mockResolvedValue({
      run: { state: 'awaiting_workspace', revision: 13 },
      events: [],
      hasMore: false,
    });
    harnessMock.readAgentSession.mockReset();
    harnessMock.readAgentSession.mockResolvedValue({ revision: 42, messages: [] });
    harnessMock.mutateAgentSession.mockReset();
    harnessMock.mutateAgentSession.mockResolvedValue({ revision: 43 });
    useStore.setState({
      aiActiveSessionId: 'source-session',
      aiChatHistory: { 'source-session': sourceMessages },
      aiChatSessions: harnessMock.session.orderedAISessions,
      aiPanelVisible: true,
      activeContext: null,
      aiContexts: {},
      connections: [],
      activeTabId: null,
      sqlLogs: [],
      appearance: { ...useStore.getState().appearance, uiVersion: 'v2' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useStore.setState(originalStore, true);
  });

  it('submits an edited user turn as an immutable source-session branch', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });

    await act(async () => {
      harnessMock.conversationProps?.onEditMessage({
        ...sourceMessages[0],
        content: 'Edited prompt',
      });
    });
    expect(harnessMock.inputProps?.input).toBe('Edited prompt');

    await act(async () => {
      await harnessMock.inputProps?.onSend();
    });

    expect(harnessMock.submitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.stringMatching(/^agent-input-/),
      sessionId: 'source-session',
      branchFromMessageId: 'user-1',
      content: 'Edited prompt',
      dispatchMode: 'queue',
      contextSourceId: 'desktop',
      contextSourceInstanceId: 'desktop-test-instance',
      provider: 'provider-1',
      model: 'model-1',
      thinking: 'medium',
      expectedRevision: 42,
    }), harnessMock.service);

    await act(async () => renderer?.unmount());
  });

  it('retries an assistant reply from its preceding durable user cursor', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });

    await act(async () => {
      await harnessMock.conversationProps?.onRetryMessage(sourceMessages[1]);
    });

    expect(harnessMock.submitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.stringMatching(/^agent-input-/),
      sessionId: 'source-session',
      branchFromMessageId: 'user-1',
      content: 'Original prompt',
      dispatchMode: 'queue',
      expectedRevision: 42,
    }), harnessMock.service);

    await act(async () => renderer?.unmount());
  });

  it('drops an abandoned edit cursor when the active session changes', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.conversationProps?.onEditMessage({
        ...sourceMessages[0],
        content: 'Prompt for another session',
      });
    });

    harnessMock.session = {
      sid: 'other-session',
      messages: [],
      orderedAISessions: [{
        id: 'other-session',
        title: 'Other',
        revision: 7,
        updatedAt: 2,
      }],
    };
    useStore.setState({ aiActiveSessionId: 'other-session' });
    await act(async () => {
      renderer?.update(
        <AIChatPanel
          darkMode={false}
          onClose={() => undefined}
          overlayTheme={buildOverlayWorkbenchTheme(false)}
        />,
      );
    });

    await act(async () => {
      await harnessMock.inputProps?.onSend();
    });

    expect(harnessMock.submitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'other-session',
      content: 'Prompt for another session',
      dispatchMode: 'queue',
      expectedRevision: 7,
    }), harnessMock.service);
    expect(harnessMock.submitAgentInput.mock.calls[0][0]).not.toHaveProperty('branchFromMessageId');

    await act(async () => renderer?.unmount());
  });

  it('uses the persisted dispatch preference for a fresh run until the user changes it', async () => {
    harnessMock.getRunPolicy.mockResolvedValue({
      schemaVersion: 1,
      revision: 2,
      policy: { defaultDispatchMode: 'steer' },
    });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
      await Promise.resolve();
    });

    expect(harnessMock.inputProps?.dispatchMode).toBe('steer');
    await act(async () => {
      harnessMock.inputProps?.setInput('Run with policy default');
    });
    await act(async () => {
      await harnessMock.inputProps?.onSend();
    });

    expect(harnessMock.submitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Run with policy default',
      dispatchMode: 'steer',
    }), harnessMock.service);

    await act(async () => renderer?.unmount());
  });

  it('lets the Ledger create a newly opened local session atomically', async () => {
    harnessMock.session = {
      sid: 'session-local-only',
      messages: [],
      orderedAISessions: [],
    };
    harnessMock.submitAgentInput.mockResolvedValueOnce(submitReceipt('durable-session'));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.inputProps?.setInput('First message in a new session');
    });
    await act(async () => {
      await harnessMock.inputProps?.onSend();
    });

    expect(harnessMock.readAgentSession).not.toHaveBeenCalledWith({
      sessionId: 'session-local-only',
      limit: 1,
    }, harnessMock.service);
    expect(harnessMock.submitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
      content: 'First message in a new session',
    }), harnessMock.service);
    expect(harnessMock.submitAgentInput.mock.calls[0][0]).not.toHaveProperty('sessionId');
    expect(harnessMock.submitAgentInput.mock.calls[0][0]).not.toHaveProperty('expectedRevision');

    await act(async () => renderer?.unmount());
  });

  it('does not add a pending bubble when the receipt is already terminal', async () => {
    const addAIChatMessage = vi.fn();
    useStore.setState({ addAIChatMessage });
    harnessMock.submitAgentInput.mockResolvedValueOnce({
      ...submitReceipt('source-session'),
      state: 'failed',
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.inputProps?.setInput('Terminal receipt');
      await harnessMock.inputProps?.onSend();
    });

    expect(addAIChatMessage).not.toHaveBeenCalledWith('source-session', expect.objectContaining({
      id: 'agent-run-run-1-pending',
      loading: true,
    }));
    await act(async () => renderer?.unmount());
  });

  it('does not resurrect a pending bubble when a terminal error event wins the receipt race', async () => {
    const addAIChatMessage = vi.fn();
    const terminalError: AIChatMessage = {
      id: 'agent-run-run-1-0-error',
      runId: 'run-1',
      role: 'assistant',
      content: 'Error: reasoning effort is invalid',
      rawError: 'reasoning effort is invalid',
      timestamp: 2,
      loading: false,
      phase: 'idle',
      excludeFromAIContext: true,
    };
    useStore.setState({
      addAIChatMessage,
      aiChatHistory: { 'source-session': [...sourceMessages, terminalError] },
    });
    harnessMock.submitAgentInput.mockResolvedValueOnce(submitReceipt('source-session'));

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.inputProps?.setInput('Receipt after failure');
      await harnessMock.inputProps?.onSend();
    });

    expect(addAIChatMessage).not.toHaveBeenCalledWith('source-session', expect.objectContaining({
      id: 'agent-run-run-1-pending',
      loading: true,
    }));
    await act(async () => renderer?.unmount());
  });

  it('keeps an event-first terminal state when its queued receipt arrives later', async () => {
    const addAIChatMessage = vi.fn();
    let resolveReceipt: ((value: ReturnType<typeof submitReceipt>) => void) | undefined;
    const receipt = new Promise<ReturnType<typeof submitReceipt>>((resolve) => {
      resolveReceipt = resolve;
    });
    useStore.setState({ addAIChatMessage });
    harnessMock.submitAgentInput.mockReturnValueOnce(receipt);

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.inputProps?.setInput('Event before receipt');
    });
    let send: Promise<void> | undefined;
    await act(async () => {
      send = harnessMock.inputProps?.onSend();
      await Promise.resolve();
    });
    await act(async () => {
      harnessMock.runSubscriptionProps?.onRunStateChange('run-1', 'failed', 2);
      resolveReceipt?.(submitReceipt('source-session'));
      await send;
    });

    expect(harnessMock.inputProps?.sending).toBe(false);
    expect(addAIChatMessage).not.toHaveBeenCalledWith('source-session', expect.objectContaining({
      id: 'agent-run-run-1-pending',
      loading: true,
    }));
    await act(async () => renderer?.unmount());
  });

  it('uses the exact run revision for a stale-workspace control and refreshes a conflict', async () => {
    harnessMock.controlAgentRun.mockRejectedValueOnce(new Error('revision_conflict: expected 12, got 13'));
    harnessMock.readAgentRun.mockResolvedValueOnce({
      run: { state: 'awaiting_workspace', revision: 13 },
      events: [],
      hasMore: false,
    });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });

    await act(async () => {
      harnessMock.runSubscriptionProps?.onRunStateChange('run-workspace', 'awaiting_workspace', 12);
    });
    const workspace = harnessMock.runControlsProps?.waitingWorkspaces?.[0];
    expect(workspace).toMatchObject({ runId: 'run-workspace', revision: 12 });

    await act(async () => {
      harnessMock.runControlsProps?.onWorkspaceAction(workspace, 'use_stale_workspace');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harnessMock.controlAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-workspace',
      sessionId: 'source-session',
      action: 'use_stale_workspace',
      expectedRevision: 12,
    }), harnessMock.service);
    expect(harnessMock.readAgentRun).toHaveBeenCalledWith({
      runId: 'run-workspace',
      afterSequence: 0,
      limit: 1,
    }, harnessMock.service);
    expect(harnessMock.runControlsProps?.waitingWorkspaces?.[0]).toMatchObject({ revision: 13 });

    await act(async () => renderer?.unmount());
  });

  it('reads a missing session revision before submitting a durable branch', async () => {
    harnessMock.session = {
      ...harnessMock.session,
      orderedAISessions: [{
        ...harnessMock.session.orderedAISessions[0],
        revision: 0,
      }],
    };
    harnessMock.readAgentSession.mockResolvedValueOnce({ revision: 84, messages: [] });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.conversationProps?.onEditMessage({
        ...sourceMessages[0],
        content: 'Edited with refreshed revision',
      });
    });
    await act(async () => {
      await harnessMock.inputProps?.onSend();
    });

    expect(harnessMock.readAgentSession).toHaveBeenCalledWith({
      sessionId: 'source-session',
      limit: 1,
    }, harnessMock.service);
    expect(harnessMock.submitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'source-session',
      expectedRevision: 84,
    }), harnessMock.service);
    await act(async () => renderer?.unmount());
  });

  it('archives an inline history session through the Ledger and removes it locally', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });

    await act(async () => {
      await harnessMock.conversationProps?.onArchiveSession({
        id: 'source-session',
        title: 'Source',
        updatedAt: 1,
        revision: 42,
      });
    });

    expect(harnessMock.mutateAgentSession).toHaveBeenCalledWith({
      sessionId: 'source-session',
      expectedRevision: 42,
      archived: true,
    }, harnessMock.service);
    expect(useStore.getState().aiChatSessions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'source-session' }),
    ]));
    expect(useStore.getState().aiChatHistory['source-session']).toBeUndefined();
    await act(async () => renderer?.unmount());
  });

  it('does not submit a durable session when its revision cannot be resolved', async () => {
    harnessMock.session = {
      ...harnessMock.session,
      orderedAISessions: [{
        ...harnessMock.session.orderedAISessions[0],
        revision: 0,
      }],
    };
    harnessMock.readAgentSession.mockResolvedValueOnce({ revision: 0, messages: [] });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.inputProps?.setInput('Cannot submit without a CAS revision');
    });
    await act(async () => {
      await harnessMock.inputProps?.onSend();
    });

    expect(harnessMock.submitAgentInput).not.toHaveBeenCalled();
    expect(useStore.getState().aiChatHistory['source-session']).toEqual(expect.arrayContaining([
      expect.objectContaining({
        excludeFromAIContext: true,
        rawError: 'AI agent session revision is unavailable',
      }),
    ]));
    await act(async () => renderer?.unmount());
  });

  it('reads a missing run revision before issuing a control command', async () => {
    harnessMock.readAgentRun.mockResolvedValueOnce({
      run: { state: 'awaiting_workspace', revision: 23, sessionId: 'source-session' },
      events: [],
      hasMore: false,
    });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.runSubscriptionProps?.onRunStateChange('run-no-revision', 'awaiting_workspace', 0);
    });
    const workspace = harnessMock.runControlsProps?.waitingWorkspaces?.[0];
    await act(async () => {
      harnessMock.runControlsProps?.onWorkspaceAction(workspace, 'use_stale_workspace');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harnessMock.readAgentRun).toHaveBeenCalledWith({
      runId: 'run-no-revision',
      afterSequence: 0,
      limit: 1,
    }, harnessMock.service);
    expect(harnessMock.controlAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-no-revision',
      expectedRevision: 23,
    }), harnessMock.service);
    await act(async () => renderer?.unmount());
  });

  it('binds an approval decision to the exact arguments hash', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = renderPanel();
    });
    await act(async () => {
      harnessMock.runSubscriptionProps?.onRunStateChange('run-approval', 'awaiting_approval', 17);
      harnessMock.runSubscriptionProps?.onApprovalChange('run-approval', {
        runId: 'run-approval',
        sessionId: 'source-session',
        approvalId: 'approval-1',
        callId: 'call-1',
        argsHash: 'sha256:exact-args',
        decision: 'pending',
        revision: 17,
      });
    });
    const approval = harnessMock.runControlsProps?.approvals?.[0];
    await act(async () => {
      harnessMock.runControlsProps?.onApprovalDecision(approval, 'approved');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harnessMock.controlAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-approval',
      action: 'approve',
      approvalId: 'approval-1',
      callId: 'call-1',
      argsHash: 'sha256:exact-args',
      expectedRevision: 17,
    }), harnessMock.service);
    await act(async () => renderer?.unmount());
  });
});
