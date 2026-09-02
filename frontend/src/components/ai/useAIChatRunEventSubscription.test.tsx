import React, { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '../../store';
import { resetAIChatRunEventProjection } from './useAIChatRunEventSubscription';
import { useAIChatRunEventSubscription } from './useAIChatRunEventSubscription';

const runtimeMock = vi.hoisted(() => {
  const handlers = new Map<string, (value: unknown) => void>();
  return {
    handlers,
    EventsOn: vi.fn((name: string, handler: (value: unknown) => void) => {
      handlers.set(name, handler);
    }),
    EventsOff: vi.fn((name: string) => handlers.delete(name)),
  };
});

vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: runtimeMock.EventsOn,
  EventsOff: runtimeMock.EventsOff,
}));

const SESSION_ID = 'run-event-session';

const makeEvent = (sequence: number, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  runId: 'run-event-1',
  sessionId: SESSION_ID,
  sessionGeneration: 1,
  sequence,
  runRevision: sequence,
  attempt: 1,
  timestamp: '2026-09-01T00:00:00Z',
  kind: 'model_delta',
  resultingState: 'running_model',
  payload: { text: `chunk-${sequence}` },
  ...overrides,
});

const appendMessage = (
  sid: string,
  message: Parameters<ReturnType<typeof useStore.getState>['addAIChatMessage']>[1],
) => {
  useStore.setState((state) => ({
    aiChatHistory: {
      ...state.aiChatHistory,
      [sid]: [...(state.aiChatHistory[sid] || []), message],
    },
  }));
};

const updateMessage = (
  sid: string,
  id: string,
  patch: Parameters<ReturnType<typeof useStore.getState>['updateAIChatMessage']>[2],
) => {
  useStore.setState((state) => ({
    aiChatHistory: {
      ...state.aiChatHistory,
      [sid]: (state.aiChatHistory[sid] || []).map((message) =>
        message.id === id ? { ...message, ...patch } : message),
    },
  }));
};

const Harness = ({
  isRunTracked,
  onSendingChange,
  onApprovalChange,
  onRecoveryChange,
  onRunStateChange,
  deleteAIChatMessage,
}: {
  isRunTracked?: (runId: string, sessionId: string) => boolean;
  onSendingChange?: (sending: boolean) => void;
  onApprovalChange?: (runId: string, approval: unknown) => void;
  onRecoveryChange?: (runId: string, recovery: unknown) => void;
  onRunStateChange?: (runId: string, state: string, revision: number) => void;
  deleteAIChatMessage?: (sid: string, messageId: string) => void;
} = {}) => {
  const [, setSending] = useState(true);
  useAIChatRunEventSubscription({
    sid: SESSION_ID,
    setSending: (sending) => {
      setSending(sending);
      onSendingChange?.(sending);
    },
    addAIChatMessage: appendMessage,
    updateAIChatMessage: updateMessage,
    deleteAIChatMessage,
    nextMessageId: () => 'unused',
    isRunTracked,
    onApprovalChange,
    onRecoveryChange,
    onRunStateChange,
  });
  return null;
};

const emit = async (value: unknown) => {
  const handler = runtimeMock.handlers.get('ai:run:event');
  expect(handler).toBeTypeOf('function');
  await act(async () => {
    handler?.(value);
    await Promise.resolve();
  });
};

describe('useAIChatRunEventSubscription', () => {
  beforeEach(() => {
    resetAIChatRunEventProjection();
    runtimeMock.handlers.clear();
    runtimeMock.EventsOn.mockClear();
    runtimeMock.EventsOff.mockClear();
    vi.stubGlobal('window', { go: { aiservice: { Service: {} } } });
    useStore.setState({
      aiChatHistory: {
        [SESSION_ID]: [{
          id: 'connecting',
          role: 'assistant',
          content: '',
          phase: 'connecting',
          loading: true,
          timestamp: 1,
        }],
      },
      aiChatSessions: [{ id: SESSION_ID, title: 'run', updatedAt: 1 }],
      aiActiveSessionId: SESSION_ID,
    });
  });

  afterEach(() => {
    resetAIChatRunEventProjection();
    vi.unstubAllGlobals();
    useStore.setState({ aiChatHistory: {}, aiChatSessions: [], aiActiveSessionId: null });
  });

  it('projects typed model deltas into the existing connecting message', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await emit(makeEvent(1));
    await emit(makeEvent(2));

    expect(useStore.getState().aiChatHistory[SESSION_ID]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'connecting',
        content: 'chunk-1chunk-2',
        phase: 'generating',
        loading: true,
      }),
    ]));
    await act(async () => renderer?.unmount());
  });

  it('ignores events for another session and recovers a sequence gap', async () => {
    const AIReadAgentRun = vi.fn().mockResolvedValue({
      events: [
        {
          ...makeEvent(1),
          payload: Array.from(new TextEncoder().encode(JSON.stringify({ text: 'chunk-1' }))),
        },
        makeEvent(2),
      ],
      hasMore: false,
    });
    vi.stubGlobal('window', { go: { aiservice: { Service: { AIReadAgentRun } } } });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await emit({ ...makeEvent(1), sessionId: 'other-session' });
    await emit(makeEvent(2));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(AIReadAgentRun).toHaveBeenCalledWith({ runId: 'run-event-1', afterSequence: 0, limit: 500 });
    expect(useStore.getState().aiChatHistory[SESSION_ID][0].content).toBe('chunk-1chunk-2');
    await act(async () => renderer?.unmount());
  });

  it('settles once on terminal and ignores late provider callbacks', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await emit(makeEvent(1));
    await emit(makeEvent(2, {
      kind: 'terminal',
      resultingState: 'completed',
      payload: { reason: 'done' },
    }));
    await emit(makeEvent(3, { payload: { text: 'late' } }));

    const messages = useStore.getState().aiChatHistory[SESSION_ID];
    expect(messages[0]).toMatchObject({ content: 'chunk-1', loading: false, phase: 'idle' });
    expect(messages[0].content).not.toContain('late');
    await act(async () => renderer?.unmount());
  });

  it('keeps an interrupted checkpoint resumable and leaves the selected session sending', async () => {
    const onSendingChange = vi.fn();
    const onRunStateChange = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness onSendingChange={onSendingChange} onRunStateChange={onRunStateChange} />);
    });
    onSendingChange.mockClear();

    await emit(makeEvent(1, {
      kind: 'input',
      resultingState: 'running_model',
      payload: { requestId: 'input-interrupted' },
    }));
    await emit(makeEvent(2, {
      kind: 'checkpoint',
      resultingState: 'interrupted',
      payload: { checkpointId: '', sequence: 1 },
    }));

    expect(onRunStateChange).toHaveBeenLastCalledWith('run-event-1', 'interrupted', 2);
    expect(onSendingChange).toHaveBeenLastCalledWith(true);
    expect(useStore.getState().aiChatHistory[SESSION_ID][0]).toMatchObject({
      id: 'connecting',
      loading: true,
      phase: 'connecting',
    });
    await act(async () => renderer?.unmount());
  });

  // `interrupted` is deliberately non-terminal: recovery/resume must be able
  // to continue the same run. A `terminal` event carrying it is invalid and
  // rejected by the typed event contract, so only cancellation settles the
  // transient assistant placeholder here.
  it.each(['canceled'] as const)(
    'keeps an empty assistant placeholder in the projection when a run is %s',
    async (state) => {
      const deleteAIChatMessage = vi.fn();
      let renderer: ReactTestRenderer | undefined;
      await act(async () => {
        renderer = create(<Harness deleteAIChatMessage={deleteAIChatMessage} />);
      });

      // The empty delta claims the connecting placeholder without adding
      // visible assistant content, which exercises the terminal fallback.
      await emit(makeEvent(1, { payload: { text: '' } }));
      await emit(makeEvent(2, {
        kind: 'terminal',
        resultingState: state,
        payload: { reason: `run ${state}` },
      }));

      expect(deleteAIChatMessage).not.toHaveBeenCalled();
      expect(useStore.getState().aiChatHistory[SESSION_ID][0]).toMatchObject({
        id: 'connecting',
        content: '',
        loading: false,
        phase: 'idle',
        excludeFromAIContext: true,
      });
      await act(async () => renderer?.unmount());
    },
  );

  it('clears a local terminal placeholder when bootstrap returns an explicit empty ledger transcript', async () => {
    const AIReadAgentSession = vi.fn().mockResolvedValue({
      messages: [],
      runs: [],
    });
    vi.stubGlobal('window', { go: { aiservice: { Service: { AIReadAgentSession } } } });
    useStore.setState({
      aiChatHistory: {
        [SESSION_ID]: [{
          id: 'terminal-placeholder',
          role: 'assistant',
          content: '',
          loading: false,
          phase: 'idle',
          excludeFromAIContext: true,
          timestamp: 1,
        }],
      },
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(AIReadAgentSession).toHaveBeenCalledWith({ sessionId: SESSION_ID, limit: 10_000 });
    expect(useStore.getState().aiChatHistory[SESSION_ID]).toEqual([]);
    await act(async () => renderer?.unmount());
  });

  it('projects tracked background runs without marking the selected session as sending', async () => {
    const onSendingChange = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <Harness
          isRunTracked={() => true}
          onSendingChange={onSendingChange}
        />,
      );
    });

    expect(onSendingChange).toHaveBeenLastCalledWith(false);
    onSendingChange.mockClear();
    await emit({
      ...makeEvent(1),
      sessionId: 'background-session',
      kind: 'input',
      resultingState: 'running_model',
      payload: { requestId: 'background-input' },
    });
    await emit({
      ...makeEvent(2),
      sessionId: 'background-session',
      kind: 'terminal',
      resultingState: 'completed',
      payload: { reason: 'done' },
    });

    expect(onSendingChange).not.toHaveBeenCalled();
    await act(async () => renderer?.unmount());
  });

  it('rebuilds a pending approval when the shared cursor was consumed by another view', async () => {
    const toolIntent = {
      callId: 'call-approval',
      toolName: 'wrong_tool_name',
      effect: 'side_effect',
      arguments: { sql: 'INSERT INTO audit_log VALUES (1)' },
    };
    const history = [
      makeEvent(1, {
        kind: 'model_completed',
        resultingState: 'running_model',
        payload: { toolCalls: [toolIntent] },
      }),
      makeEvent(2, {
        kind: 'approval',
        resultingState: 'awaiting_approval',
        payload: {
          approvalId: 'approval-replay',
          callId: 'call-approval',
          toolName: 'execute_sql',
          effect: 'side_effect',
          argsHash: 'sha256:approval-replay',
          decision: 'pending',
          summary: 'Add one audit entry',
        },
      }),
    ];

    let firstRenderer: ReactTestRenderer | undefined;
    await act(async () => {
      firstRenderer = create(<Harness />);
    });
    await emit(history[0]);
    await emit(history[1]);
    await act(async () => firstRenderer?.unmount());

    const onApprovalChange = vi.fn();
    const AIReadAgentRun = vi.fn().mockResolvedValue({
      events: history,
      hasMore: false,
    });
    const AIReadAgentSession = vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-event-1', state: 'awaiting_approval', revision: 2 }],
      messages: [],
    });
    vi.stubGlobal('window', {
      go: { aiservice: { Service: { AIReadAgentRun, AIReadAgentSession } } },
    });

    let secondRenderer: ReactTestRenderer | undefined;
    await act(async () => {
      secondRenderer = create(<Harness onApprovalChange={onApprovalChange} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(AIReadAgentRun).toHaveBeenCalledWith({ runId: 'run-event-1', afterSequence: 0, limit: 500 });
    const approval = onApprovalChange.mock.calls.find(([, value]) => value)?.[1];
    expect(approval).toMatchObject({
      approvalId: 'approval-replay',
      callId: 'call-approval',
      toolName: 'execute_sql',
      effect: 'side_effect',
      argsHash: 'sha256:approval-replay',
      summary: 'Add one audit entry',
    });
    expect(approval).not.toHaveProperty('arguments');
    expect(JSON.stringify(approval)).not.toContain('INSERT INTO audit_log');
    await act(async () => secondRenderer?.unmount());
  });

  it('keeps later model turns visible when replay overlaps an already consumed turn', async () => {
    const history = [
      makeEvent(1, { payload: { text: 'first' } }),
      makeEvent(2, {
        kind: 'model_completed',
        resultingState: 'running_model',
        payload: { text: 'first' },
      }),
      makeEvent(3, { payload: { text: 'second' } }),
      makeEvent(4, {
        kind: 'model_completed',
        resultingState: 'awaiting_approval',
        payload: { text: 'second' },
      }),
    ];

    let firstRenderer: ReactTestRenderer | undefined;
    await act(async () => {
      firstRenderer = create(<Harness />);
    });
    await emit(history[0]);
    await emit(history[1]);
    await act(async () => firstRenderer?.unmount());

    const AIReadAgentRun = vi.fn().mockResolvedValue({ events: history, hasMore: false });
    const AIReadAgentSession = vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-event-1', state: 'awaiting_approval', revision: 4 }],
      messages: [{
        id: 'assistant-1',
        runId: 'run-event-1',
        role: 'assistant',
        content: 'first',
        createdAt: 2,
      }],
    });
    vi.stubGlobal('window', {
      go: { aiservice: { Service: { AIReadAgentRun, AIReadAgentSession } } },
    });

    let secondRenderer: ReactTestRenderer | undefined;
    await act(async () => {
      secondRenderer = create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const assistants = useStore.getState().aiChatHistory[SESSION_ID]
      .filter((message) => message.role === 'assistant');
    expect(assistants.some((message) => message.content === 'second')).toBe(true);
    expect(assistants.filter((message) => message.content === 'first')).toHaveLength(1);
    await act(async () => secondRenderer?.unmount());
  });

  it('does not regress run state revisions while replaying an older shared cursor', async () => {
    const history = [
      makeEvent(1, { kind: 'input', resultingState: 'running_model', payload: {} }),
      makeEvent(2, { kind: 'model_delta', resultingState: 'running_model' }),
      makeEvent(3, { kind: 'approval', resultingState: 'awaiting_approval', payload: {
        approvalId: 'approval-state', callId: 'call-state', decision: 'pending',
      } }),
    ];

    let firstRenderer: ReactTestRenderer | undefined;
    await act(async () => {
      firstRenderer = create(<Harness />);
    });
    await emit(history[0]);
    await emit(history[1]);
    await emit(history[2]);
    await act(async () => firstRenderer?.unmount());

    const AIReadAgentRun = vi.fn().mockResolvedValue({ events: history, hasMore: false });
    const AIReadAgentSession = vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-event-1', state: 'awaiting_approval', revision: 3 }],
      messages: [],
    });
    vi.stubGlobal('window', {
      go: { aiservice: { Service: { AIReadAgentRun, AIReadAgentSession } } },
    });
    const revisions: number[] = [];
    let secondRenderer: ReactTestRenderer | undefined;
    await act(async () => {
      secondRenderer = create(<Harness onRunStateChange={(_runId, _state, revision) => revisions.push(revision)} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(revisions).toEqual([3]);
    await act(async () => secondRenderer?.unmount());
  });

  it('does not duplicate durable assistant text during a refresh replay', async () => {
    const history = [
      makeEvent(1, {
        kind: 'model_delta',
        payload: { text: 'hello' },
      }),
      makeEvent(2, {
        kind: 'model_completed',
        resultingState: 'awaiting_approval',
        payload: { text: 'hello' },
      }),
    ];
    const AIReadAgentRun = vi.fn().mockResolvedValue({ events: history, hasMore: false });
    const AIReadAgentSession = vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-event-1', state: 'awaiting_approval', revision: 2 }],
      messages: [
        { id: 'user-1', runId: 'run-event-1', role: 'user', content: 'question', createdAt: 1 },
        { id: 'assistant-1', runId: 'run-event-1', role: 'assistant', content: 'hello', createdAt: 2 },
      ],
    });
    vi.stubGlobal('window', {
      go: { aiservice: { Service: { AIReadAgentRun, AIReadAgentSession } } },
    });
    // A browser refresh creates a new module-level cursor. Reproduce that
    // boundary while retaining the durable session projection in the store.
    resetAIChatRunEventProjection();

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const assistants = useStore.getState().aiChatHistory[SESSION_ID]
      .filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ id: 'assistant-1', content: 'hello' });
    expect(assistants[0].content).not.toContain('hellohello');
    expect(AIReadAgentRun).toHaveBeenCalledWith({ runId: 'run-event-1', afterSequence: 0, limit: 500 });
    await act(async () => renderer?.unmount());
  });

  it('keeps deltas for an incomplete model turn during a refresh replay', async () => {
    const AIReadAgentRun = vi.fn().mockResolvedValue({
      events: [makeEvent(1, { payload: { text: 'partial' } })],
      hasMore: false,
    });
    const AIReadAgentSession = vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-event-1', state: 'running_model', revision: 1 }],
      messages: [{ id: 'user-1', role: 'user', content: 'question', createdAt: 1 }],
    });
    vi.stubGlobal('window', {
      go: { aiservice: { Service: { AIReadAgentRun, AIReadAgentSession } } },
    });
    resetAIChatRunEventProjection();

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const assistants = useStore.getState().aiChatHistory[SESSION_ID]
      .filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: 'partial', loading: true });
    await act(async () => renderer?.unmount());
  });

  it('does not globally remove a shared event when the runtime returns no disposer', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => renderer?.unmount());

    expect(runtimeMock.EventsOff).not.toHaveBeenCalled();
  });
});
