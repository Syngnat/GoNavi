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
  'ai_chat.message.jvm.apply_preview',
  'ai_chat.message.jvm.apply_diagnostic',
  'ai_chat.message.jvm.missing_plan_context',
  'ai_chat.message.jvm.plan_target_not_found',
  'ai_chat.message.jvm.missing_diagnostic_context',
  'ai_chat.message.jvm.diagnostic_target_not_found',
] as const;

const AI_MESSAGE_BUBBLE_SOURCE = new URL('./AIMessageBubble.tsx', import.meta.url);

describe('AIMessageBubble', () => {
  it('renders thinking, tool progress and raw error actions after extracting status blocks', () => {
    const markup = renderToStaticMarkup(
      <AIMessageBubble
        msg={{
          id: 'assistant-1',
          role: 'assistant',
          content: '这里是诊断结论。',
          thinking: '先看连接，再看表结构。',
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
});
