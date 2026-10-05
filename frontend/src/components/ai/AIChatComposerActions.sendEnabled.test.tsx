import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import AIChatComposerActions from './AIChatComposerActions';
import { t as catalogTranslate } from '../../i18n/catalog';

const baseProps = {
  input: '',
  draftAttachmentCount: 0,
  sending: false,
  overlayTheme: {
    mutedText: '#666', titleText: '#111', iconBg: '#f5f5f5', iconColor: '#1677ff', hoverBg: '#f5f5f5',
    selectedBg: '#e6f4ff', selectedText: '#1677ff', divider: '#eee', sectionBorder: '1px solid #eee',
  } as any,
  fileInputRef: { current: null } as React.RefObject<HTMLInputElement>,
  onAttachmentUpload: () => undefined,
  onOpenContext: () => undefined,
  onOpenSlashMenu: () => undefined,
  onSend: () => undefined,
  onStop: () => undefined,
};

// The send button is the one with the "Send" title; antd renders `disabled` on it.
const sendButtonDisabled = (props: Partial<React.ComponentProps<typeof AIChatComposerActions>>): boolean => {
  const markup = renderToStaticMarkup(<AIChatComposerActions {...baseProps} {...props} />);
  const button = markup.match(/<button[^>]*title="Send"[^>]*>/)?.[0] || '';
  expect(button).not.toBe('');
  return /\sdisabled(=|\s|>)/.test(button);
};

describe('AIChatComposerActions send availability', () => {
  it('cannot send an empty message', () => {
    expect(sendButtonDisabled({})).toBe(true);
  });

  it('can send what was typed', () => {
    expect(sendButtonDisabled({ input: 'select 1' })).toBe(false);
  });

  it('can send an attachment on its own', () => {
    expect(sendButtonDisabled({ draftAttachmentCount: 1 })).toBe(false);
  });

  it('can send a bound editor selection without any typed text', () => {
    expect(sendButtonDisabled({ hasBoundSelection: true })).toBe(false);
  });

  it('has a default question for it in every language the app ships', () => {
    for (const language of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'de-DE', 'ru-RU'] as const) {
      const prompt = catalogTranslate(language, 'ai_chat.input.default_selection_prompt');
      expect(prompt, language).not.toBe('ai_chat.input.default_selection_prompt');
      expect(prompt.length, language).toBeGreaterThan(8);
    }
  });
});
