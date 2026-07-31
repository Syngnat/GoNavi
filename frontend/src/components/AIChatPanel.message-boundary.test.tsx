import { describe, expect, it } from 'vitest';

import { t as catalogTranslate } from '../i18n/catalog';

const REQUIRED_RENDER_BOUNDARY_KEYS = [
  'ai_chat.message.render_error.title',
  'ai_chat.message.render_error.body',
  'ai_chat.message.render_error.unknown',
  'ai_chat.message.render_error.retry',
  'ai_chat.message.render_error.delete',
] as const;

describe('AIChatPanel merge resolution', () => {

  it('keeps render-boundary recovery chrome translated through catalog keys', () => {
    for (const key of REQUIRED_RENDER_BOUNDARY_KEYS) {
      expect(catalogTranslate('en-US', key)).not.toBe(key);
      expect(catalogTranslate('zh-CN', key)).not.toBe(key);
    }

    for (const oldCopy of [
      '这条 AI 消息渲染失败，已自动隔离',
      '其余对话仍可继续使用。你可以先删除这条异常消息，再继续操作。',
      '未知渲染错误',
      '重试渲染',
      '删除这条消息',
    ]) {
    }
  });
});
