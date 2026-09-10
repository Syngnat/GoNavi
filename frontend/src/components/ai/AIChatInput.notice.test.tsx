import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { I18nParams } from '../../i18n/types';
import { AIChatInput } from './AIChatInput';
import AIChatComposerStatus from './AIChatComposerStatus';
import { buildAIChatReadinessSnapshot } from './aiChatReadiness';
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

vi.mock('../../i18n/provider', async () => {
  const { t } = await import('../../i18n/catalog');
  const mockedI18n = {
    language: 'zh-CN',
    preference: 'zh-CN',
    setPreference: () => undefined,
    t: (key: string, params?: I18nParams) => t('zh-CN', key, params),
  };
  return {
    useI18n: () => mockedI18n,
    useOptionalI18n: () => mockedI18n,
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

const buildAIChatInput = (overrides: Partial<React.ComponentProps<typeof AIChatInput>> = {}) => (
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
);

const renderAIChatInput = (overrides: Partial<React.ComponentProps<typeof AIChatInput>> = {}) =>
  renderToStaticMarkup(buildAIChatInput(overrides));

describe('AIChatInput notice layout', () => {
  it('renders the composer notice above the input editor', () => {
    const markup = renderToStaticMarkup(
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
        composerNotice={{
          tone: 'error',
          title: '模型列表加载失败',
          description: '请检查供应商入口和 API Key。',
          action: {
            key: 'reload-models',
            label: '重新加载模型',
          },
        }}
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

      />
    );

    const noticeIndex = markup.indexOf('data-ai-chat-composer-notice="true"');
    const inputIndex = markup.indexOf('data-ai-chat-composer-input="true"');

    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(inputIndex);
  });

  it('renders the selected send shortcut in the composer placeholder', () => {
    const markup = renderToStaticMarkup(
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
        sendShortcutBinding={{ combo: 'Meta+Enter', enabled: true }}
        shortcutPlatform="mac"
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

      />
    );

    expect(markup).toContain('⌘↵ 发送');
  });

  it('renders the model selector without the filled select variant', () => {
    const markup = renderToStaticMarkup(
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
        activeProvider={{ ...baseProvider, model: 'gpt-5.5', models: ['gpt-5.5'] }}
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

      />
    );

    expect(markup).toContain('gn-v2-ai-model-select');
    expect(markup).toContain('gn-v2-ai-thinking-select');
    expect(markup).toContain('gn-v2-ai-model-bar');
    expect(markup).not.toContain('ant-select-filled');
    expect(markup).not.toContain('ant-select-show-search');
  });

  it('renders an enabled type-safe send button when text is present', () => {
    const markup = renderAIChatInput({ input: 'select 1' });
    const sendButton = markup.match(/<button[^>]*class="ai-chat-send-btn gn-v2-ai-send"[^>]*>/)?.[0] || '';

    expect(sendButton).toContain('type="button"');
    expect(sendButton).toContain('title="发送"');
    expect(sendButton).not.toContain('disabled');
  });

  it('keeps v2 composer action controls available after rendering the input', () => {
    const markup = renderAIChatInput({ input: 'select 1' });

    expect(markup).toContain('gn-v2-ai-input-actions');
    expect(markup).toContain('aria-label="picture"');
    expect(markup).toContain('aria-label="table"');
    expect(markup).toContain('aria-label="code"');
  });

  it('renders an actionable composer notice button when the notice provides an action', () => {
    const markup = renderAIChatInput({
      composerNotice: {
        tone: 'warning',
        title: '还没有可用供应商',
        description: '先在 AI 设置里添加并启用一个模型供应商。',
        action: {
          key: 'open-settings',
          label: '打开 AI 设置',
        },
      },
      onComposerAction: () => {},
    });

    expect(markup).toContain('打开 AI 设置');
  });

  it('renders a proactive readiness status when no active provider is configured yet', () => {
    const markup = renderAIChatInput({ activeProvider: null });

    expect(markup).toContain('data-ai-chat-composer-status="true"');
    expect(markup).toContain('还没有配置 AI 供应商');
    expect(markup).toContain('打开 AI 设置');
  });

  it('surfaces incomplete provider state before send when base url or secret is missing', () => {
    const markup = renderAIChatInput({
      activeProvider: {
        id: 'provider-1',
        type: 'custom',
        name: '自建代理',
        apiKey: '',
        hasSecret: false,
        baseUrl: '',
        model: '',
        models: [],
        maxTokens: 16000,
        temperature: 0.7,
      },
    });

    expect(markup).toContain('自建代理 还缺少 密钥、接口地址');
    expect(markup).toContain('修复供应商配置');
  });

  it('renders a dismiss affordance for the non-blocking ready composer status', () => {
    const snapshot = buildAIChatReadinessSnapshot({
      activeProvider: {
        ...baseProvider,
        model: 'MiniMax-M2.7-highspeed',
        models: ['MiniMax-M2.7-highspeed'],
      },
    });
    const markup = renderToStaticMarkup(
      <AIChatComposerStatus
        snapshot={snapshot}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('data-ai-chat-composer-status="true"');
    expect(markup).toContain('aria-label="关闭 AI 状态提示"');
    expect(markup).toContain('title="关闭"');
  });
});
