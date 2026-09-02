import { describe, expect, it } from 'vitest';

import type { AIChatMessage } from '../../types';
import {
  canRetryAIChatAssistantMessage,
  collectRetryableAIChatAssistantMessageIds,
  resolveAIChatRetryPlan,
} from './aiChatRetrySafety';

const message = (overrides: Partial<AIChatMessage>): AIChatMessage => ({
  id: 'message',
  role: 'assistant',
  content: '',
  timestamp: 1,
  ...overrides,
});

describe('aiChatRetrySafety', () => {
  it('allows retrying a settled plain-text assistant turn', () => {
    const messages = [
      message({ id: 'user-1', role: 'user', content: '解释这个查询' }),
      message({ id: 'assistant-1', content: '查询说明' }),
    ];

    expect(canRetryAIChatAssistantMessage(messages, 'assistant-1')).toBe(true);
  });

  it('rejects explicitly excluded errors and active assistant placeholders', () => {
    const messages = [
      message({ id: 'user-1', role: 'user', content: '继续' }),
      message({ id: 'timeout', content: '请求超时', excludeFromAIContext: true }),
      message({
        id: 'connecting',
        content: '连接中',
        phase: 'connecting',
        loading: true,
      }),
    ];

    expect(collectRetryableAIChatAssistantMessageIds(messages)).toEqual(new Set());
    expect(resolveAIChatRetryPlan(messages, 'timeout')).toBeNull();
  });

  it('allows a retry after a completed tool round because it creates a branch', () => {
    const messages = [
      message({ id: 'user-1', role: 'user', content: '插入测试数据' }),
      message({ id: 'assistant-before-tool', content: '准备执行' }),
      message({
        id: 'assistant-tool-call',
        content: '正在插入',
        tool_calls: [{
          id: 'call-insert',
          type: 'function',
          function: { name: 'execute_sql', arguments: '{"sql":"INSERT INTO t VALUES (1)"}' },
        }],
      }),
      message({
        id: 'tool-result',
        role: 'tool',
        content: '{"affectedRows":1}',
        tool_call_id: 'call-insert',
      }),
      message({ id: 'assistant-after-tool', content: '已插入 1 行' }),
    ];

    expect(collectRetryableAIChatAssistantMessageIds(messages)).toEqual(new Set([
      'assistant-before-tool',
      'assistant-tool-call',
      'assistant-after-tool',
    ]));
    expect(resolveAIChatRetryPlan(messages, 'assistant-after-tool')).toMatchObject({
      targetMessageIndex: 4,
      userMessageIndex: 0,
      userMessage: expect.objectContaining({ id: 'user-1' }),
    });
  });

  it('allows a retry before later user turns because the source transcript is immutable', () => {
    const messages = [
      message({ id: 'user-1', role: 'user', content: '先解释' }),
      message({ id: 'assistant-plain', content: '解释完成' }),
      message({ id: 'user-2', role: 'user', content: '现在插入' }),
      message({
        id: 'assistant-tool-call',
        content: '开始插入',
        tool_calls: [{
          id: 'call-later-insert',
          type: 'function',
          function: { name: 'execute_sql', arguments: '{"sql":"INSERT INTO t VALUES (2)"}' },
        }],
      }),
      message({
        id: 'tool-result',
        role: 'tool',
        content: '{"affectedRows":1}',
        tool_call_id: 'call-later-insert',
      }),
    ];

    expect(canRetryAIChatAssistantMessage(messages, 'assistant-plain')).toBe(true);
  });

  it('keeps a later plain-text turn retryable when prior tool history stays before its user boundary', () => {
    const messages = [
      message({ id: 'user-1', role: 'user', content: '读取表结构' }),
      message({
        id: 'assistant-tool-call',
        content: '读取中',
        tool_calls: [{
          id: 'call-read',
          type: 'function',
          function: { name: 'get_columns', arguments: '{}' },
        }],
      }),
      message({
        id: 'tool-result',
        role: 'tool',
        content: '{"columns":["id"]}',
        tool_call_id: 'call-read',
      }),
      message({ id: 'user-2', role: 'user', content: '只解释结果' }),
      message({ id: 'assistant-plain', content: '结果说明' }),
    ];

    expect(canRetryAIChatAssistantMessage(messages, 'assistant-plain')).toBe(true);
    expect(resolveAIChatRetryPlan(messages, 'assistant-plain')).toMatchObject({
      targetMessageIndex: 4,
      userMessageIndex: 3,
      userMessage: expect.objectContaining({ id: 'user-2' }),
      requestHistory: expect.arrayContaining([
        expect.objectContaining({ id: 'user-2' }),
      ]),
    });
  });
});
