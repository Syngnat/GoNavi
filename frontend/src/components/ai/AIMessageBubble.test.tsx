import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AIMessageBubble } from './AIMessageBubble';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import { t as catalogTranslate } from '../../i18n/catalog';

const REQUIRED_MESSAGE_BUBBLE_KEYS = [
  'ai_chat.message.action.copy_full',
  'ai_chat.message.action.copied',
  'ai_chat.message.action.delete',
  'ai_chat.message.action.edit',
  'ai_chat.message.action.retry',
  'ai_chat.message.action.copy_error_raw',
  'ai_chat.message.action.copied_error_raw',
  'ai_chat.message.role.user',
  'ai_chat.message.image_alt',
  'ai_chat.message.wait.connecting',
  'ai_chat.message.wait.generating',
  'ai_chat.message.activity.title',
  'ai_chat.message.activity.kind.model',
  'ai_chat.message.activity.kind.tool',
  'ai_chat.message.activity.status.active',
  'ai_chat.message.activity.summary.completed',
  'ai_chat.message.jvm.apply_preview',
  'ai_chat.message.jvm.apply_diagnostic',
  'ai_chat.message.jvm.missing_plan_context',
  'ai_chat.message.jvm.plan_target_not_found',
  'ai_chat.message.jvm.missing_diagnostic_context',
  'ai_chat.message.jvm.diagnostic_target_not_found',
] as const;

const AI_MESSAGE_BUBBLE_SOURCE = new URL('./AIMessageBubble.tsx', import.meta.url);

describe('AIMessageBubble', () => {
  const renderActionBar = (canRetry: boolean, excludeFromAIContext?: boolean) => renderToStaticMarkup(
    <AIMessageBubble
      msg={{
        id: canRetry ? 'assistant-retryable' : 'assistant-blocked',
        role: 'assistant',
        content: excludeFromAIContext ? '请求超时' : '普通回复',
        timestamp: Date.now(),
        excludeFromAIContext,
      }}
      canRetry={canRetry}
      darkMode={false}
      overlayTheme={buildOverlayWorkbenchTheme(false)}
      textColor="#1f2937"
      onEdit={() => {}}
      onRetry={() => {}}
      onDelete={() => {}}
      toolResultsById={new Map()}
    />,
  );

  it('renders Harness reasoning, tool progress and raw error actions after extracting status blocks', () => {
    const markup = renderToStaticMarkup(
      <AIMessageBubble
        msg={{
          id: 'assistant-1',
          role: 'assistant',
          content: '这里是诊断结论。',
          reasoning_content: '先看连接，再看表结构。',
          rawError: 'driver timeout',
          timestamp: Date.now(),
          tool_calls: [
            {
              id: 'tool-1',
              type: 'function',
              function: {
                name: 'get_foreign_keys',
                arguments: '{}',
              },
            },
          ],
        }}
        canRetry={false}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#1f2937"
        onEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        toolResultsById={new Map([
          ['tool-1', {
            id: 'tool-result-1',
            role: 'tool',
            content: '[{\"fk\":\"orders.customer_id\"}]',
            timestamp: Date.now(),
            tool_call_id: 'tool-1',
            tool_name: 'get_foreign_keys',
          }],
        ])}
      />,
    );

    expect(markup).toContain('GoNavi AI');
    expect(markup).toContain('Thinking process');
    expect(markup).toContain('Map foreign key relationships');
    expect(markup).toContain('Copy raw error');
    expect(markup).toContain('Data probes completed');
  });

  it('keeps an empty streaming generation visibly pending instead of rendering an empty bubble', () => {
    const markup = renderToStaticMarkup(
      <AIMessageBubble
        msg={{
          id: 'assistant-generating',
          role: 'assistant',
          content: '',
          phase: 'generating',
          loading: true,
          timestamp: Date.now(),
        }}
        canRetry={false}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#1f2937"
        onEdit={() => {}}
        onRetry={() => {}}
        toolResultsById={new Map()}
      />,
    );

    expect(markup).toContain('Generating response');
    expect(markup).toContain('ai-wave-pulse');
    expect(markup).not.toContain('GoNavi AI');
  });

  it('renders a redacted Harness activity timeline while a tool is running', () => {
    const markup = renderToStaticMarkup(
      <AIMessageBubble
        msg={{
          id: 'assistant-activity',
          role: 'assistant',
          content: '正在检查数据库结构。',
          phase: 'tool_calling',
          loading: true,
          timestamp: Date.now(),
          runActivities: [
            { id: 'model:1', kind: 'model', status: 'completed', timestamp: 1 },
            {
              id: 'tool:1',
              kind: 'tool',
              status: 'active',
              timestamp: 2,
              toolName: 'get_tables',
              errorCode: 'provider-secret-should-not-render',
            },
          ],
        }}
        canRetry={false}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#1f2937"
        onEdit={() => {}}
        onRetry={() => {}}
        toolResultsById={new Map()}
      />,
    );

    expect(markup).toContain('Run activity');
    expect(markup).toContain('Tool: Analyze table structure info · in progress');
    expect(markup).toContain('data-activity-kind="tool"');
    expect(markup).not.toContain('provider-secret-should-not-render');
  });

  it('hides the internal run node when a concrete active activity is available', () => {
    const markup = renderToStaticMarkup(
      <AIMessageBubble
        msg={{
          id: 'assistant-active-model',
          role: 'assistant',
          content: '正在处理请求。',
          loading: true,
          timestamp: Date.now(),
          runActivities: [
            { id: 'run', kind: 'run', status: 'active', timestamp: 1 },
            { id: 'model:1', kind: 'model', status: 'active', timestamp: 2 },
          ],
        }}
        canRetry={false}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#1f2937"
        onEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        toolResultsById={new Map()}
      />,
    );

    expect(markup).toContain('Run activity');
    expect(markup).toContain('in progress');
    expect(markup).not.toContain('data-activity-kind="run"');
    expect((markup.match(/Model · in progress/g) || [])).toHaveLength(1);
  });

  it('keeps completed activity history available as a collapsed summary', () => {
    const markup = renderToStaticMarkup(
      <AIMessageBubble
        msg={{
          id: 'assistant-completed-activity',
          role: 'assistant',
          content: '已完成。',
          timestamp: Date.now(),
          runActivities: [
            { id: 'model:1', kind: 'model', status: 'completed', timestamp: 1 },
            { id: 'tool:1', kind: 'tool', status: 'completed', timestamp: 2, toolName: 'get_tables' },
            { id: 'run', kind: 'run', status: 'completed', timestamp: 3 },
          ],
        }}
        canRetry={false}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        textColor="#1f2937"
        onEdit={() => {}}
        onRetry={() => {}}
        toolResultsById={new Map()}
      />,
    );

    expect(markup).toContain('2 steps completed');
    expect(markup).toContain('aria-expanded="false"');
  });

  it('uses catalog fallback keys for message bubble UI chrome', () => {
    for (const key of REQUIRED_MESSAGE_BUBBLE_KEYS) {
      expect(catalogTranslate('en-US', key)).not.toBe(key);
      expect(catalogTranslate('zh-CN', key)).not.toBe(key);
    }

    for (const oldCopy of [
      '已复制',
      '复制全文',
      '编辑此条消息',
      '重新生成',
      '删除单条消息',
      '复制报错原文',
      '正在建立连接',
      '这条 JVM 计划缺少来源页签上下文',
      '未找到与该 JVM 计划匹配的资源页签',
      '这条诊断计划缺少来源页签上下文',
      '未找到与该诊断计划匹配的诊断控制台页签',
      '应用到 JVM 预览',
      '应用到诊断控制台',
    ]) {
    }
  });

  it('only renders Reload when the full conversation marks the assistant retry as safe', () => {
    expect(renderActionBar(true)).toContain('anticon-reload');
    expect(renderActionBar(false, true)).not.toContain('anticon-reload');
  });
});
