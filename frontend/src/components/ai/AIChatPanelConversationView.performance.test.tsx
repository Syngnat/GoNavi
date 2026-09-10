import React, { createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { AIChatMessage } from '../../types';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIChatPanelConversationView from './AIChatPanelConversationView';

const bubbleRenderCounts = vi.hoisted(() => new Map<string, number>());
const toolIndexBuilds = vi.hoisted(() => ({ count: 0 }));

vi.mock('./aiToolResultIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiToolResultIndex')>();
  return {
    ...actual,
    buildAIToolResultIndex: (messages: readonly AIChatMessage[]) => {
      toolIndexBuilds.count += 1;
      return actual.buildAIToolResultIndex(messages);
    },
  };
});

vi.mock('./AIMessageBubble', async () => {
  const ReactModule = await import('react');
  return {
    AIMessageBubble: ReactModule.memo(({ msg }: { msg: AIChatMessage }) => {
      bubbleRenderCounts.set(msg.id, (bubbleRenderCounts.get(msg.id) || 0) + 1);
      return <div data-message-id={msg.id}>{msg.content}</div>;
    }),
  };
});

vi.mock('./AIMessageRenderBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./AIChatPanelModeContent', () => ({
  default: () => null,
}));

const overlayTheme = buildOverlayWorkbenchTheme(false);
const noop = () => {};

const renderConversation = (messages: AIChatMessage[]) => (
  <AIChatPanelConversationView
    mode="chat"
    messages={messages}
    darkMode={false}
    overlayTheme={overlayTheme}
    textColor="#0f172a"
    mutedColor="#64748b"
    quickActionBg="rgba(255,255,255,0.8)"
    quickActionBorder="1px solid rgba(0,0,0,0.06)"
    showScrollBottom={false}
    contextTableNames={[]}

    insights={[]}
    sessions={[]}
    activeSessionId="session-performance"
    messagesEndRef={createRef<HTMLDivElement>()}
    onScrollMessages={noop}
    onQuickAction={noop}
    onSelectSession={noop}
    onEditMessage={noop}
    onRetryMessage={noop}
    onDeleteMessage={noop}
    onMessageRenderError={noop}
    onScrollBottom={noop}
  />
);

describe('AIChatPanelConversationView streaming render performance', () => {
  it('does not rerender the previous 499 bubbles when only the newest message streams', () => {
    bubbleRenderCounts.clear();
    toolIndexBuilds.count = 0;
    const messages = Array.from({ length: 500 }, (_, index): AIChatMessage => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `content-${index}`,
      timestamp: index,
    }));

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(renderConversation(messages));
    });
    expect(bubbleRenderCounts.get('message-0')).toBe(1);
    expect(bubbleRenderCounts.get('message-499')).toBe(1);

    const nextMessages = [...messages];
    nextMessages[499] = { ...messages[499], content: 'content-499-next-token' };
    act(() => {
      renderer.update(renderConversation(nextMessages));
    });

    for (let index = 0; index < 499; index += 1) {
      expect(bubbleRenderCounts.get(`message-${index}`)).toBe(1);
    }
    expect(bubbleRenderCounts.get('message-499')).toBe(2);
  });

  it('builds one shared tool-result index instead of scanning history in every tool block', () => {
    bubbleRenderCounts.clear();
    toolIndexBuilds.count = 0;
    const messages: AIChatMessage[] = [];
    for (let index = 0; index < 40; index += 1) {
      messages.push({
        id: `assistant-${index}`,
        role: 'assistant',
        content: '',
        timestamp: index * 2,
        tool_calls: [{
          id: `call-${index}`,
          type: 'function',
          function: { name: 'inspect_ai_runtime', arguments: '{}' },
        }],
      });
      messages.push({
        id: `tool-${index}`,
        role: 'tool',
        content: `result-${index}`,
        timestamp: index * 2 + 1,
        tool_call_id: `call-${index}`,
        tool_name: 'inspect_ai_runtime',
      });
    }

    act(() => {
      create(renderConversation(messages));
    });

    expect(toolIndexBuilds.count).toBe(1);
  });

  it('rerenders only the assistant whose relevant tool result changes', () => {
    bubbleRenderCounts.clear();
    toolIndexBuilds.count = 0;
    const toolCallMessage: AIChatMessage = {
      id: 'assistant-with-tool',
      role: 'assistant',
      content: '',
      timestamp: 1,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect_ai_runtime', arguments: '{}' },
      }],
    };
    const unrelatedMessage: AIChatMessage = {
      id: 'assistant-unrelated',
      role: 'assistant',
      content: 'stable',
      timestamp: 2,
    };
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(renderConversation([toolCallMessage, unrelatedMessage]));
    });

    const resultMessage: AIChatMessage = {
      id: 'tool-result-1',
      role: 'tool',
      content: 'result',
      timestamp: 3,
      tool_call_id: 'call-1',
      tool_name: 'inspect_ai_runtime',
    };
    act(() => {
      renderer.update(renderConversation([toolCallMessage, unrelatedMessage, resultMessage]));
    });

    expect(bubbleRenderCounts.get('assistant-with-tool')).toBe(2);
    expect(bubbleRenderCounts.get('assistant-unrelated')).toBe(1);
  });
});
