import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import { AIChatInput } from './AIChatInput';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

vi.mock('../../store', () => ({
  useStore: (selector: (state: any) => any) => selector({
    aiContexts: {},
    addAIContext: vi.fn(),
    removeAIContext: vi.fn(),
  }),
}));

vi.mock('../../../wailsjs/go/app/App', () => ({
  DBGetTables: vi.fn(),
  DBShowCreateTable: vi.fn(),
  DBGetDatabases: vi.fn(),
  DBGetColumns: vi.fn(),
}));

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const actual = await vi.importActual<any>('antd');
  return {
    ...actual,
    Tooltip: ({
      title,
      children,
    }: {
      title?: React.ReactNode;
      children?: React.ReactNode;
    }) => React.createElement(
      'div',
      { 'data-tooltip-title': typeof title === 'string' ? title : undefined },
      children,
    ),
  };
});

const baseProvider = {
  id: 'provider-1',
  type: 'openai' as const,
  name: 'OpenAI 主账号',
  apiKey: '',
  hasSecret: true,
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  models: [] as string[],
  maxTokens: 32000,
  temperature: 0.2,
};

const renderAIChatInput = (
  language: 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'de-DE' | 'ru-RU',
  overrides: Partial<React.ComponentProps<typeof AIChatInput>> = {},
) => renderToStaticMarkup(
  <I18nProvider
    preference={language}
    systemLanguages={[language]}
    onPreferenceChange={() => undefined}
  >
    <AIChatInput
      input=""
      setInput={() => {}}
      draftAttachments={[]}
      setDraftAttachments={() => {}}
      sending={false}
      onSend={() => {}}
      onStop={() => {}}
      handleKeyDown={() => {}}
      activeConnName=""
      activeContext={null}
      activeProvider={baseProvider}
      dynamicModels={[]}
      loadingModels={false}
      sendShortcutBinding={{ combo: 'Enter', enabled: true }}
      composerNotice={null}
      onComposerAction={() => {}}
      onModelChange={() => {}}
      onFetchModels={() => {}}
      thinkingIntensity="medium"
      onThinkingIntensityChange={() => {}}
      textareaRef={React.createRef<HTMLTextAreaElement>()}
      darkMode={false}
      textColor="#162033"
      mutedColor="rgba(16,24,40,0.55)"
      overlayTheme={buildOverlayWorkbenchTheme(false)}

      {...overrides}
    />
  </I18nProvider>,
);

const renderAIChatInputWithoutProvider = (
  overrides: Partial<React.ComponentProps<typeof AIChatInput>> = {},
) => renderToStaticMarkup(
  <AIChatInput
    input=""
    setInput={() => {}}
    draftAttachments={[]}
    setDraftAttachments={() => {}}
    sending={false}
    onSend={() => {}}
    onStop={() => {}}
    handleKeyDown={() => {}}
    activeConnName=""
    activeContext={null}
    activeProvider={baseProvider}
    dynamicModels={[]}
    loadingModels={false}
    sendShortcutBinding={{ combo: 'Enter', enabled: true }}
    composerNotice={null}
    onComposerAction={() => {}}
    onModelChange={() => {}}
    onFetchModels={() => {}}
    thinkingIntensity="medium"
    onThinkingIntensityChange={() => {}}
    textareaRef={React.createRef<HTMLTextAreaElement>()}
    darkMode={false}
    textColor="#162033"
    mutedColor="rgba(16,24,40,0.55)"
    overlayTheme={buildOverlayWorkbenchTheme(false)}

    {...overrides}
  />,
);

describe('AIChatInput i18n source guards', () => {

  it('renders the localized placeholder in en-US with the dynamic shortcut label', () => {
    const markup = renderAIChatInput('en-US', {
      sendShortcutBinding: { combo: 'Meta+Enter', enabled: true },
      shortcutPlatform: 'mac',
    });

    expect(markup).toContain('placeholder="Type a message... ⌘↵ to send · / commands"');
  });

  it('renders the disabled shortcut placeholder copy instead of falling back to Enter', () => {
    const markup = renderAIChatInput('en-US', {
      sendShortcutBinding: { combo: 'Enter', enabled: false },
    });

    expect(markup).toContain('Shortcut sending disabled');
    expect(markup).not.toContain('Enter to send');
  });

  it('renders localized connection context tooltips in en-US while preserving raw connection context', () => {
    const markup = renderAIChatInput('en-US', {
      activeConnName: 'orders-db',
      activeContext: { connectionId: 'conn-1', dbName: 'analytics' },
    });

    expect(markup).toContain('data-tooltip-title="Current data query context"');
    expect(markup).toContain('orders-db / analytics');
  });

  it('renders localized memory usage tooltips in en-US while preserving the raw limit label', () => {
    const markup = renderAIChatInput('en-US', {
      contextUsageChars: 12800,
      maxContextChars: 32000,
    });

    expect(markup).toContain('data-tooltip-title="Current session memory usage. Auto-compression starts when it reaches the 32k limit."');
    expect(markup).toContain('12.8k/32k');
  });

  it('falls back to English placeholders and tooltips without an i18n provider while preserving raw connection context', () => {
    expect(() => renderAIChatInputWithoutProvider({
      activeConnName: 'orders-db',
      activeContext: { connectionId: 'conn-1', dbName: 'analytics' },
      contextUsageChars: 12800,
      maxContextChars: 32000,
      sendShortcutBinding: { combo: 'Meta+Enter', enabled: true },
      shortcutPlatform: 'mac',
    })).not.toThrow();

    const markup = renderAIChatInputWithoutProvider({
      activeConnName: 'orders-db',
      activeContext: { connectionId: 'conn-1', dbName: 'analytics' },
      contextUsageChars: 12800,
      maxContextChars: 32000,
      sendShortcutBinding: { combo: 'Meta+Enter', enabled: true },
      shortcutPlatform: 'mac',
    });

    expect(markup).toContain('placeholder="Type a message... ⌘↵ to send · / commands"');
    expect(markup).toContain('data-tooltip-title="Current data query context"');
    expect(markup).toContain('data-tooltip-title="Current session memory usage. Auto-compression starts when it reaches the 32k limit."');
    expect(markup).toContain('orders-db / analytics');
    expect(markup).not.toContain('ai_chat.input.context.connection_tooltip');
  });
});
