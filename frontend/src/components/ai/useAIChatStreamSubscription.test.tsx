import React, { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useStore } from '../../store';
import {
  flushAIChatStreamBuffers,
  prepareAIChatStreamForTerminalAction,
  useAIChatStreamSubscription,
} from './useAIChatStreamSubscription';

const aiChatStreamMock = vi.hoisted(() => vi.fn(async (..._args: any[]) => undefined));
const generateTitleForSessionMock = vi.hoisted(() => vi.fn(async () => undefined));
const runtimeMock = vi.hoisted(() => {
  const handlers = new Map<string, (data: any) => void>();
  return {
    handlers,
    EventsOn: vi.fn((eventName: string, handler: (data: any) => void) => {
      handlers.set(eventName, handler);
    }),
    EventsOff: vi.fn((eventName: string) => {
      handlers.delete(eventName);
    }),
  };
});

vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: runtimeMock.EventsOn,
  EventsOff: runtimeMock.EventsOff,
}));

const SESSION_ID = 'session-stream';
const translatedCopy: Record<string, string> = {
  'ai_chat.panel.model_control.force_tool_call': 'T:force-tool-call',
  'ai_chat.panel.message.error': 'T:error {{detail}}',
  'ai_chat.panel.message.empty_response': 'T:empty-response',
  'ai_chat.panel.message.request_interrupted': 'T:request-interrupted',
};

const translate = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => (translatedCopy[key] || key).replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params?.[name] ?? ''));
let nextId = 0;
let patchMessageCalls = 0;

const emitStreamChunk = async (data: any) => {
  const handler = runtimeMock.handlers.get(`ai:stream:${SESSION_ID}`);
  expect(handler).toBeTypeOf('function');
  await act(async () => {
    handler?.(data);
    await Promise.resolve();
  });
};

const appendMessage = (
  sessionId: string,
  message: Parameters<ReturnType<typeof useStore.getState>['addAIChatMessage']>[1],
) => {
  useStore.setState((state) => {
    const messages = state.aiChatHistory[sessionId] || [];
    return {
      aiChatHistory: {
        ...state.aiChatHistory,
        [sessionId]: [...messages, message],
      },
    };
  });
};

const patchMessage = (
  sessionId: string,
  messageId: string,
  patch: Parameters<ReturnType<typeof useStore.getState>['updateAIChatMessage']>[2],
) => {
  patchMessageCalls += 1;
  useStore.setState((state) => {
    const messages = state.aiChatHistory[sessionId];
    if (!messages) {
      return state;
    }
    return {
      aiChatHistory: {
        ...state.aiChatHistory,
        [sessionId]: messages.map((message) =>
          message.id === messageId ? { ...message, ...patch } : message,
        ),
      },
    };
  });
};

const StreamHarness = () => {
  const [sending, setSending] = useState(true);
  const nudgeCountRef = useRef(0);
  const pendingJVMPlanContextRef = useRef<any>(undefined);
  const pendingJVMDiagnosticPlanContextRef = useRef<any>(undefined);

  useAIChatStreamSubscription({
    sid: SESSION_ID,
    sending,
    setSending,
    availableTools: [],
    addAIChatMessage: appendMessage,
    updateAIChatMessage: patchMessage,
    buildSystemContextMessages: async () => [],
    executeLocalTools: async () => {},
    generateTitleForSession: generateTitleForSessionMock,
    nextMessageId: () => `assistant-created-${++nextId}`,
    nudgeCountRef,
    pendingJVMPlanContextRef,
    pendingJVMDiagnosticPlanContextRef,
    translate,
  });

  return <span data-sending={sending ? 'true' : 'false'} />;
};

describe('useAIChatStreamSubscription', () => {

  beforeEach(() => {
    nextId = 0;
    patchMessageCalls = 0;
    aiChatStreamMock.mockClear();
    generateTitleForSessionMock.mockClear();
    runtimeMock.handlers.clear();
    runtimeMock.EventsOn.mockClear();
    runtimeMock.EventsOff.mockClear();
    vi.stubGlobal('window', {
      go: {
        aiservice: {
          Service: {
            AIChatStream: aiChatStreamMock,
          },
        },
      },
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useStore.setState({
      aiChatHistory: {
        [SESSION_ID]: [
          {
            id: 'user-1',
            role: 'user',
            content: 'hello',
            timestamp: 1,
          },
          {
            id: 'assistant-connecting',
            role: 'assistant',
            phase: 'connecting',
            content: '',
            timestamp: 2,
            loading: true,
          },
        ],
      },
      aiChatSessions: [{ id: SESSION_ID, title: 'hello', updatedAt: 1 }],
      aiActiveSessionId: SESSION_ID,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useStore.setState({
      aiChatHistory: {},
      aiChatSessions: [],
      aiActiveSessionId: null,
    });
  });

  it('keeps streamed chunks in the same assistant message after a parent rerender', async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ content: 'Hello' });
    await emitStreamChunk({ content: ' world' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90);
    });

    const messages = useStore.getState().aiChatHistory[SESSION_ID] || [];
    const assistantMessages = messages.filter((message) => message.role === 'assistant');

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      id: 'assistant-connecting',
      phase: 'generating',
      content: 'Hello world',
      loading: true,
    });

    await act(async () => {
      renderer?.unmount();
    });
  });

  it('keeps session actions locked until the stream reaches done', async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ content: 'first token' });
    expect(renderer!.root.findByType('span').props['data-sending']).toBe('true');

    await emitStreamChunk({ done: true });
    expect(renderer!.root.findByType('span').props['data-sending']).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(renderer!.root.findByType('span').props['data-sending']).toBe('false');

    await act(async () => {
      renderer?.unmount();
    });
  });

  it('coalesces high-frequency thinking chunks before writing them to the store', async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ thinking: 'A' });
    const callsAfterScheduling = patchMessageCalls;
    await emitStreamChunk({ thinking: 'B' });
    await emitStreamChunk({ thinking: 'C' });

    expect(patchMessageCalls).toBe(callsAfterScheduling);
    expect(
      (useStore.getState().aiChatHistory[SESSION_ID] || []).find((message) => message.id === 'assistant-connecting'),
    ).not.toHaveProperty('thinking');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90);
    });

    expect(
      (useStore.getState().aiChatHistory[SESSION_ID] || []).find((message) => message.id === 'assistant-connecting'),
    ).toMatchObject({
      thinking: 'ABC',
      phase: 'thinking',
    });
    expect(patchMessageCalls).toBe(callsAfterScheduling + 1);

    await act(async () => {
      renderer?.unmount();
    });
  });

  it('flushes the final buffered token synchronously before a detached window exits', async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ content: 'tail' });
    flushAIChatStreamBuffers([SESSION_ID]);

    expect(
      (useStore.getState().aiChatHistory[SESSION_ID] || []).find(
        (message) => message.id === 'assistant-connecting',
      )?.content,
    ).toBe('tail');
    await act(async () => {
      renderer?.unmount();
    });
  });

  it('keeps the streaming message active when cancel-and-wait cannot stop the producer', async () => {
    const setSending = vi.fn();
    const cancelAndWait = vi.fn(async () => false);

    await expect(prepareAIChatStreamForTerminalAction({
      sid: SESSION_ID,
      service: { AIChatCancelAndWait: cancelAndWait },
      setSending,
      settleDelayMs: 0,
    })).resolves.toBe(false);

    expect(cancelAndWait).toHaveBeenCalledWith(SESSION_ID);
    expect(setSending).not.toHaveBeenCalled();
    expect(
      (useStore.getState().aiChatHistory[SESSION_ID] || []).find(
        (message) => message.id === 'assistant-connecting',
      ),
    ).toMatchObject({ loading: true, phase: 'connecting' });
  });

  it('flushes buffered content and settles loading assistant messages after cancellation', async () => {
    vi.useFakeTimers();
    const setSending = vi.fn();
    const cancelAndWait = vi.fn(async () => true);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ content: 'final token' });
    await expect(prepareAIChatStreamForTerminalAction({
      sid: SESSION_ID,
      service: { AIChatCancelAndWait: cancelAndWait },
      setSending,
      settleDelayMs: 0,
    })).resolves.toBe(true);

    expect(
      (useStore.getState().aiChatHistory[SESSION_ID] || []).find(
        (message) => message.id === 'assistant-connecting',
      ),
    ).toMatchObject({
      content: 'final token',
      loading: false,
      phase: 'idle',
    });
    expect(setSending).toHaveBeenCalledWith(false);
    await act(async () => {
      renderer?.unmount();
    });
  });

  it('cancels and settles every session before a native terminal handoff', async () => {
    const setSending = vi.fn();
    const cancelAllAndWait = vi.fn(async () => true);
    const cancelAndWait = vi.fn(async () => true);
    useStore.setState((state) => ({
      aiChatHistory: {
        ...state.aiChatHistory,
        'session-other': [{
          id: 'assistant-other',
          role: 'assistant',
          content: 'partial',
          timestamp: 3,
          loading: true,
          phase: 'generating',
        }],
      },
      aiChatSessions: [
        ...state.aiChatSessions,
        { id: 'session-other', title: 'other', updatedAt: 3 },
      ],
    }));

    await expect(prepareAIChatStreamForTerminalAction({
      sid: SESSION_ID,
      service: {
        AIChatCancelAllAndWait: cancelAllAndWait,
        AIChatCancelAndWait: cancelAndWait,
      },
      setSending,
      settleDelayMs: 0,
      allSessions: true,
    })).resolves.toBe(true);

    expect(cancelAllAndWait).toHaveBeenCalledOnce();
    expect(cancelAndWait).not.toHaveBeenCalled();
    expect(
      (useStore.getState().aiChatHistory[SESSION_ID] || []).find(
        (message) => message.id === 'assistant-connecting',
      ),
    ).toMatchObject({ loading: false, phase: 'idle' });
    expect(
      (useStore.getState().aiChatHistory['session-other'] || []).find(
        (message) => message.id === 'assistant-other',
      ),
    ).toMatchObject({ loading: false, phase: 'idle' });
    expect(setSending).toHaveBeenCalledWith(false);
  });

  it('resends a localized force-tool-call nudge when the model only describes the next action', async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ content: '我先查询一下相关信息' });
    await emitStreamChunk({ done: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(aiChatStreamMock).toHaveBeenCalledTimes(1);
    const resentMessages = (aiChatStreamMock.mock.calls[0]?.[1] ?? []) as Array<{ role: string; content: string }>;
    expect(resentMessages[resentMessages.length - 1]).toEqual({ role: 'user', content: 'T:force-tool-call' });
    expect(generateTitleForSessionMock).not.toHaveBeenCalled();

    await act(async () => {
      renderer?.unmount();
    });
  });

  it('resends a localized force-tool-call nudge when the model describes the next action in English', async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ content: "I'll check the relevant information first" });
    await emitStreamChunk({ done: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(aiChatStreamMock).toHaveBeenCalledTimes(1);
    const resentMessages = (aiChatStreamMock.mock.calls[0]?.[1] ?? []) as Array<{ role: string; content: string }>;
    expect(resentMessages[resentMessages.length - 1]).toEqual({ role: 'user', content: 'T:force-tool-call' });
    expect(generateTitleForSessionMock).not.toHaveBeenCalled();

    await act(async () => {
      renderer?.unmount();
    });
  });

  it('resends a localized force-tool-call nudge when the model describes the next action in Traditional Chinese', async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ content: '我先查詢一下相關資料' });
    await emitStreamChunk({ done: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(aiChatStreamMock).toHaveBeenCalledTimes(1);
    const resentMessages = (aiChatStreamMock.mock.calls[0]?.[1] ?? []) as Array<{ role: string; content: string }>;
    expect(resentMessages[resentMessages.length - 1]).toEqual({ role: 'user', content: 'T:force-tool-call' });
    expect(generateTitleForSessionMock).not.toHaveBeenCalled();

    await act(async () => {
      renderer?.unmount();
    });
  });

  it('localizes stream error copy while preserving the sanitized raw detail', async () => {
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ error: 'rpc failure' });

    const messages = useStore.getState().aiChatHistory[SESSION_ID] || [];
    const assistant = messages.find((message) => message.id === 'assistant-connecting');
    expect(assistant).toMatchObject({
      content: 'T:error rpc failure',
      phase: 'idle',
      loading: false,
    });

    await act(async () => {
      renderer?.unmount();
    });
  });

  it('localizes the empty-response fallback when the stream completes without content', async () => {
    vi.useFakeTimers();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ done: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    const messages = useStore.getState().aiChatHistory[SESSION_ID] || [];
    const assistant = messages.find((message) => message.id === 'assistant-connecting');
    expect(assistant).toMatchObject({
      content: 'T:empty-response',
      phase: 'idle',
      loading: false,
    });

    await act(async () => {
      renderer?.unmount();
    });
  });

  it('localizes the interrupted-request fallback when no assistant message was created', async () => {
    vi.useFakeTimers();
    useStore.setState({
      aiChatHistory: {
        [SESSION_ID]: [
          {
            id: 'user-1',
            role: 'user',
            content: 'hello',
            timestamp: 1,
          },
        ],
      },
      aiChatSessions: [{ id: SESSION_ID, title: 'hello', updatedAt: 1 }],
      aiActiveSessionId: SESSION_ID,
    });

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<StreamHarness />);
    });

    await emitStreamChunk({ done: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    const messages = useStore.getState().aiChatHistory[SESSION_ID] || [];
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'T:request-interrupted',
        loading: false,
      }),
    ]));

    await act(async () => {
      renderer?.unmount();
    });
  });
});
