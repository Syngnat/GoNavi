import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import AISettingsPromptsSection from './AISettingsPromptsSection';
import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

const renderPromptsSection = (language: 'zh-CN' | 'en-US') => renderToStaticMarkup(
  <I18nProvider
    preference={language}
    systemLanguages={[language]}
    onPreferenceChange={() => undefined}
  >
    <AISettingsPromptsSection
      builtinPrompts={{ 数据库: '生成 SQL 前必须先确认字段名。' }}
      userPromptSettings={{
        global: '',
        database: '',
        jvm: '',
        jvmDiagnostic: '',
      }}
      overlayTheme={buildOverlayWorkbenchTheme(false)}
      cardBg="#fff"
      cardBorder="rgba(0,0,0,0.08)"
      inputBg="#fff"
      darkMode={false}
      loading={false}
      onChangeUserPrompt={() => {}}
      onSave={() => {}}
    />
  </I18nProvider>
);

describe('AISettingsPromptsSection', () => {
  it('renders editable user prompts and readonly builtin prompt blocks after extraction', () => {
    const markup = renderPromptsSection('zh-CN');

    expect(markup).toContain('用户级自定义提示词');
    expect(markup).toContain('全局补充提示词');
    expect(markup).toContain('保存自定义提示词');
    expect(markup).toContain('数据库');
    expect(markup).toContain('生成 SQL 前必须先确认字段名');
  });

  it('renders user prompt chrome from the active locale while preserving builtin prompt raw text', () => {
    const markup = renderPromptsSection('en-US');

    expect(markup).toContain('User-level custom prompts');
    expect(markup).toContain('Global extra prompt');
    expect(markup).toContain('Save custom prompts');
    expect(markup).toContain('Leave empty to add nothing extra');
    expect(markup).toContain('数据库');
    expect(markup).toContain('生成 SQL 前必须先确认字段名');
    expect(markup).not.toContain('用户级自定义提示词');
    expect(markup).not.toContain('保存自定义提示词');
  });

  it('uses spaced flat sections without horizontal dividers', () => {
    const markup = renderPromptsSection('en-US');

    expect(markup).toContain('gonavi-ai-user-prompts-editor');
    expect(markup).toContain('gonavi-ai-builtin-prompt');
    expect(markup).not.toContain('border-bottom:1px solid rgba(0,0,0,0.08)');
    expect(markup).not.toContain('border-top:1px solid rgba(0,0,0,0.08)');
    expect(markup).toContain('border-left:2px solid rgba(0,0,0,0.08)');
  });

  it('uses native disclosures and keeps collapsed prompt content mounted', () => {
    const markup = renderPromptsSection('zh-CN');

    expect(markup).toContain('<details class="gonavi-ai-settings-disclosure gonavi-ai-user-prompt"');
    expect(markup).toContain('<details class="gonavi-ai-settings-disclosure gonavi-ai-builtin-prompt"');
    expect(markup).toContain('<summary');
    expect(markup).toContain('gonavi-ai-settings-disclosure-content');
    expect(markup).toContain('gonavi-ai-settings-disclosure-icon');
    expect(markup).toContain('生成 SQL 前必须先确认字段名');
    expect(markup).toContain('aria-label="全局补充提示词"');
  });
});
