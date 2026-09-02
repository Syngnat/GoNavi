import { describe, expect, it } from 'vitest';
import type { AIChatMessage, AIToolCall } from '../types';
import { toAIRequestMessage, toAIRequestMessages } from './aiMessagePayload';

const toolCall: AIToolCall = {
  id: 'call_schema',
  type: 'function',
  function: {
    name: 'inspect_table_schema',
    arguments: '{"table":"orders"}',
  },
};

const message = (overrides: Partial<AIChatMessage>): AIChatMessage => ({
  id: 'msg-1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  ...overrides,
});

const translateAttachmentPrompt = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string => ({
  'ai_chat.input.attachment.kind.markdown': 'Markdown',
  'ai_chat.input.attachment.prompt.heading': `### Attachment ${params?.index}: ${params?.name}`,
  'ai_chat.input.attachment.prompt.kind': `- Type: ${params?.kind}`,
  'ai_chat.input.attachment.prompt.mime': `- MIME: ${params?.mimeType}`,
  'ai_chat.input.attachment.prompt.size': `- Size: ${params?.size}`,
  'ai_chat.input.attachment.prompt.no_text': 'No readable attachment body was extracted.',
  'ai_chat.input.attachment.prompt.default_user_content': 'Continue based on the following attachment content.',
  'ai_chat.input.attachment.prompt.wrapper_start': '<User Uploaded Attachments>',
  'ai_chat.input.attachment.prompt.wrapper_end': '</User Uploaded Attachments>',
}[key] || key);

describe('toAIRequestMessage', () => {
  it.each([
    ['raw markers', '<tool_call>execute_sql<arg_key>connectionId</arg_key>'],
    ['escaped markers', '\\<tool_call>execute_sql\\<arg_value>connection-1\\</arg_value>'],
    ['HTML-encoded markers', '&lt;tool_call&gt;execute_sql&lt;arg_key&gt;sql&lt;/arg_key&gt;'],
    ['mixed markers', '<tool_call>execute_sql &lt;arg_value&gt;SELECT 1&lt;/arg_value&gt;'],
  ])('strips leaked %s and everything after it from assistant content', (_name, leakedMarkup) => {
    const payload = toAIRequestMessage(message({
      content: `明细已插入 90,000 行。现在验证各表行数：  \n${leakedMarkup}`,
    }));

    expect(payload).toEqual({
      role: 'assistant',
      content: '明细已插入 90,000 行。现在验证各表行数：',
    });
  });

  it.each([
    ['tool-call tag alone', '这里解释 <tool_call> 标签的用途。'],
    ['argument tags without a tool call', '参数格式是 <arg_key>sql</arg_key> 和 <arg_value>SELECT 1</arg_value>。'],
    ['argument tag before the only tool-call tag', '先看 <arg_key>sql</arg_key>，再说明 <tool_call>。'],
    ['HTML-encoded tool-call tag alone', '这里解释 &lt;tool_call&gt; 标签的用途。'],
  ])('preserves assistant content containing an isolated %s', (_name, content) => {
    expect(toAIRequestMessage(message({ content }))).toEqual({
      role: 'assistant',
      content,
    });
  });

  it('preserves tool-call-like text quoted by a user verbatim', () => {
    const quotedContent = '又变成这样了：\\<tool_call>execute_sql &lt;arg_key&gt;sql&lt;/arg_key&gt; <arg_value>SELECT 1</arg_value>';

    expect(toAIRequestMessage(message({
      role: 'user',
      content: quotedContent,
    }))).toEqual({
      role: 'user',
      content: quotedContent,
    });
  });

  it('keeps reasoning_content on assistant tool-call messages', () => {
    const payload = toAIRequestMessage(message({
      tool_calls: [toolCall],
      reasoning_content: '需要先检查表结构',
    }));

    expect(payload).toMatchObject({
      role: 'assistant',
      tool_calls: [toolCall],
      reasoning_content: '需要先检查表结构',
    });
  });

  it('keeps reasoning_content on assistant messages without tool calls', () => {
    const payload = toAIRequestMessage(message({
      content: '最终分析',
      reasoning_content: '工具调用轮次的最终思考也需要保留',
    }));

    expect(payload).toMatchObject({
      role: 'assistant',
      content: '最终分析',
      reasoning_content: '工具调用轮次的最终思考也需要保留',
    });
  });

  it('omits reasoning_content from tool result messages while keeping tool_call_id', () => {
    const payload = toAIRequestMessage(message({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call_schema',
      reasoning_content: '不应回传',
    }));

    expect(payload).toMatchObject({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call_schema',
    });
    expect(payload).not.toHaveProperty('reasoning_content');
  });

  it('keeps user images without adding empty tool fields', () => {
    const payload = toAIRequestMessage(message({
      role: 'user',
      content: '看图',
      images: ['data:image/png;base64,abc'],
    }));

    expect(payload).toEqual({
      role: 'user',
      content: '看图',
      images: ['data:image/png;base64,abc'],
    });
  });

  it('appends extracted file attachment content to the user request payload', () => {
    const payload = toAIRequestMessage(message({
      role: 'user',
      content: '帮我看附件',
      attachments: [{
        id: 'att-1',
        name: 'report.md',
        mimeType: 'text/markdown',
        size: 24,
        kind: 'markdown',
        text: '# 周报\n收入下降',
      }],
    }), translateAttachmentPrompt as any);

    expect(payload.content).toContain('帮我看附件');
    expect(payload.content).toContain('<User Uploaded Attachments>');
    expect(payload.content).toContain('### Attachment 1: report.md');
    expect(payload.content).toContain('report.md');
    expect(payload.content).toContain('收入下降');
    expect(payload.content).not.toContain('<用户上传附件>');
  });
});

describe('toAIRequestMessages', () => {
  it('filters every message explicitly excluded from AI context', () => {
    const payloads = toAIRequestMessages([
      message({ id: 'user-kept', role: 'user', content: '继续' }),
      message({ id: 'assistant-excluded', content: '流式响应失败', excludeFromAIContext: true }),
      message({
        id: 'tool-excluded',
        role: 'tool',
        content: 'JSON Parse error',
        tool_call_id: 'call_invalid',
        excludeFromAIContext: true,
      }),
      message({ id: 'assistant-kept', content: '已恢复' }),
    ]);

    expect(payloads).toEqual([
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '已恢复' },
    ]);
  });

  it('keeps normal assistant, tool, and user payloads unchanged', () => {
    const payloads = toAIRequestMessages([
      message({
        id: 'assistant-normal',
        content: '先检查表结构',
        tool_calls: [toolCall],
        reasoning_content: '需要读取真实字段',
      }),
      message({
        id: 'tool-normal',
        role: 'tool',
        content: '{"columns":["id"]}',
        tool_call_id: 'call_schema',
      }),
      message({
        id: 'user-normal',
        role: 'user',
        content: '继续',
        images: ['data:image/png;base64,abc'],
      }),
    ]);

    expect(payloads).toEqual([
      {
        role: 'assistant',
        content: '先检查表结构',
        tool_calls: [toolCall],
        reasoning_content: '需要读取真实字段',
      },
      {
        role: 'tool',
        content: '{"columns":["id"]}',
        tool_call_id: 'call_schema',
      },
      {
        role: 'user',
        content: '继续',
        images: ['data:image/png;base64,abc'],
      },
    ]);
  });

  it('drops malformed tool arguments together with their matching tool result', () => {
    const malformedToolCall: AIToolCall = {
      ...toolCall,
      id: 'call-malformed',
      function: {
        ...toolCall.function,
        name: 'execute_sql',
        arguments: '{"connectionId":"connection-1"',
      },
    };
    const payloads = toAIRequestMessages([
      message({
        id: 'assistant-malformed',
        tool_calls: [malformedToolCall],
      }),
      message({
        id: 'tool-malformed-result',
        role: 'tool',
        content: "Expected ',' or '}' after property value in JSON",
        tool_call_id: malformedToolCall.id,
      }),
      message({ id: 'continue', role: 'user', content: '继续' }),
    ]);

    expect(payloads).toEqual([{ role: 'user', content: '继续' }]);
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"query"'],
    ['a number', '1'],
    ['a boolean', 'true'],
  ])('drops %s arguments even when they are valid JSON', (_label, argumentsJSON) => {
    const nonObjectToolCall: AIToolCall = {
      ...toolCall,
      id: 'call-non-object',
      function: {
        ...toolCall.function,
        arguments: argumentsJSON,
      },
    };
    const payloads = toAIRequestMessages([
      message({ id: 'assistant-non-object', tool_calls: [nonObjectToolCall] }),
      message({
        id: 'tool-non-object-result',
        role: 'tool',
        content: 'invalid arguments',
        tool_call_id: nonObjectToolCall.id,
      }),
      message({ id: 'continue', role: 'user', content: '继续' }),
    ]);

    expect(payloads).toEqual([{ role: 'user', content: '继续' }]);
  });

  it.each([
    ['empty', ''],
    ['blank', '  \n\t'],
  ])('normalizes %s tool arguments to an empty object', (_label, argumentsJSON) => {
    const noArgumentToolCall: AIToolCall = {
      ...toolCall,
      id: 'call-no-arguments',
      function: {
        ...toolCall.function,
        arguments: argumentsJSON,
      },
    };
    const payloads = toAIRequestMessages([
      message({ id: 'assistant-no-arguments', tool_calls: [noArgumentToolCall] }),
      message({
        id: 'tool-no-arguments-result',
        role: 'tool',
        content: '{"ok":true}',
        tool_call_id: noArgumentToolCall.id,
      }),
    ]);

    expect(payloads[0]?.tool_calls?.[0]?.function.arguments).toBe('{}');
    expect(payloads[1]).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: noArgumentToolCall.id,
    });
  });

  it('keeps object arguments with missing required fields paired with their validation result', () => {
    const incompleteToolCall: AIToolCall = {
      ...toolCall,
      id: 'call-incomplete',
      function: {
        ...toolCall.function,
        name: 'execute_sql',
        arguments: '{"connectionId":"connection-1"}',
      },
    };
    const payloads = toAIRequestMessages([
      message({ id: 'assistant-incomplete', tool_calls: [incompleteToolCall] }),
      message({
        id: 'tool-incomplete-result',
        role: 'tool',
        content: 'missing or invalid required fields: dbName, sql',
        tool_call_id: incompleteToolCall.id,
      }),
    ]);

    expect(payloads).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [incompleteToolCall],
      },
      {
        role: 'tool',
        content: 'missing or invalid required fields: dbName, sql',
        tool_call_id: incompleteToolCall.id,
      },
    ]);
  });

  it('drops a legacy runtime-error tool-call turn together with its adjacent tool result', () => {
    const payloads = toAIRequestMessages([
      message({
        id: 'legacy-call-error',
        content: '❌ Error: context deadline exceeded',
        tool_calls: [toolCall],
      }),
      message({
        id: 'legacy-call-result',
        role: 'tool',
        content: '{"affectedRows":90000}',
        tool_call_id: toolCall.id,
      }),
      message({ id: 'continue', role: 'user', content: '继续' }),
    ]);

    expect(payloads).toEqual([{ role: 'user', content: '继续' }]);
  });

  it('does not associate a non-adjacent tool result across a user-message boundary', () => {
    const payloads = toAIRequestMessages([
      message({
        id: 'legacy-call-error',
        content: '❌ Error: context deadline exceeded',
        tool_calls: [toolCall],
      }),
      message({ id: 'boundary', role: 'user', content: '保留这个边界' }),
      message({
        id: 'non-adjacent-result',
        role: 'tool',
        content: '{"affectedRows":90000}',
        tool_call_id: toolCall.id,
      }),
    ]);

    expect(payloads).toEqual([{ role: 'user', content: '保留这个边界' }]);
  });

  it.each([
    [
      'a missing result',
      [message({ id: 'call-only', content: '', tool_calls: [toolCall] })],
    ],
    [
      'a standalone result',
      [message({ id: 'result-only', role: 'tool', content: 'ok', tool_call_id: toolCall.id })],
    ],
    [
      'duplicate results',
      [
        message({ id: 'call-duplicate-result', content: '', tool_calls: [toolCall] }),
        message({ id: 'result-1', role: 'tool', content: 'one', tool_call_id: toolCall.id }),
        message({ id: 'result-2', role: 'tool', content: 'two', tool_call_id: toolCall.id }),
      ],
    ],
    [
      'an unexpected result ID',
      [
        message({ id: 'call-unexpected-result', content: '', tool_calls: [toolCall] }),
        message({ id: 'result-unexpected', role: 'tool', content: 'wrong', tool_call_id: 'call-other' }),
      ],
    ],
  ])('drops an invalid tool history containing %s instead of emitting orphan protocol messages', (_label, invalidTurn) => {
    const payloads = toAIRequestMessages([
      ...invalidTurn,
      message({ id: 'continue-after-invalid', role: 'user', content: '继续' }),
    ]);

    expect(payloads).toEqual([{ role: 'user', content: '继续' }]);
  });

  it('filters legacy runtime errors across language changes without dropping ordinary assistant or user content', () => {
    const translateEnglishCopy = (
      key: string,
      params?: Record<string, string | number | boolean | null | undefined>,
    ): string => ({
      'ai_chat.panel.message.error': `❌ Error: ${params?.detail ?? ''}`,
      'ai_chat.panel.message.send_failed': `❌ Send failed: ${params?.detail ?? ''}`,
      'ai_chat.panel.message.empty_response': '❌ The model did not return any content.',
      'ai_chat.panel.message.request_interrupted': '❌ Request interrupted: no concrete reply was received.',
    }[key] || key);
    const orphanToolCall: AIToolCall = {
      id: 'call-orphan',
      type: 'function',
      function: {
        name: 'execute_sql',
        arguments: '{"connectionId":"connection-1"',
      },
    };

    const payloads = toAIRequestMessages([
      message({
        id: 'legacy-runtime-error',
        content: '❌ 错误: context deadline exceeded',
      }),
      message({
        id: 'assistant-real-content',
        content: '❌ 错误: orders 缺少主键，请先补充主键再重试。',
      }),
      message({
        id: 'legacy-orphan-error',
        content: '❌ Error: malformed tool arguments',
        tool_calls: [orphanToolCall],
      }),
      message({
        id: 'user-error-quote',
        role: 'user',
        content: '我看到的是：❌ 错误: context deadline exceeded',
      }),
    ], translateEnglishCopy);

    expect(payloads).toEqual([
      {
        role: 'assistant',
        content: '❌ 错误: orders 缺少主键，请先补充主键再重试。',
      },
      {
        role: 'user',
        content: '我看到的是：❌ 错误: context deadline exceeded',
      },
    ]);
  });
});
