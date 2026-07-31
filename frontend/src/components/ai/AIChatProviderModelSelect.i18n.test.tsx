import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import AIChatProviderModelSelect from './AIChatProviderModelSelect';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  return {
    Select: ({
      className,
      placeholder,
    }: {
      className?: string;
      placeholder?: string;
    }) => React.createElement(
      'div',
      {
        className,
        'data-placeholder': placeholder,
      },
      placeholder,
    ),
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  return {
    DownOutlined: () => React.createElement('span', { 'data-icon': 'down' }),
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

const renderModelSelect = (variant: 'legacy' | 'v2') => renderToStaticMarkup(
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    <AIChatProviderModelSelect
      activeProvider={baseProvider}
      dynamicModels={[]}
      loadingModels={false}
      variant={variant}
      onModelChange={() => undefined}
      onFetchModels={() => undefined}
    />
  </I18nProvider>,
);

const renderModelSelectWithoutProvider = (variant: 'legacy' | 'v2') => renderToStaticMarkup(
  <AIChatProviderModelSelect
    activeProvider={baseProvider}
    dynamicModels={[]}
    loadingModels={false}
    variant={variant}
    onModelChange={() => undefined}
    onFetchModels={() => undefined}
  />,
);

const renderLocalCLIModelSelect = (variant: 'legacy' | 'v2') => renderToStaticMarkup(
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    <AIChatProviderModelSelect
      activeProvider={{
        ...baseProvider,
        type: 'custom',
        authMode: 'local-cli',
        apiFormat: 'codex-cli',
        name: 'Codex Subscription',
      }}
      dynamicModels={[]}
      loadingModels={false}
      variant={variant}
      onModelChange={() => undefined}
      onFetchModels={() => undefined}
    />
  </I18nProvider>,
);

const renderInvalidLocalCLIModelSelect = (variant: 'legacy' | 'v2') => renderToStaticMarkup(
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    <AIChatProviderModelSelect
      activeProvider={{
        ...baseProvider,
        type: 'custom',
        authMode: 'local-cli',
        apiFormat: 'openai',
      }}
      dynamicModels={[]}
      loadingModels={false}
      variant={variant}
      onModelChange={() => undefined}
      onFetchModels={() => undefined}
    />
  </I18nProvider>,
);

describe('AIChatProviderModelSelect i18n source guards', () => {

  it('renders the localized placeholder for both legacy and v2 variants', () => {
    expect(renderModelSelect('legacy')).toContain('Select model');
    expect(renderModelSelect('v2')).toContain('Select model');
  });

  it('falls back to the English placeholder without an i18n provider', () => {
    expect(() => renderModelSelectWithoutProvider('legacy')).not.toThrow();
    expect(() => renderModelSelectWithoutProvider('v2')).not.toThrow();
    expect(renderModelSelectWithoutProvider('legacy')).toContain('Select model');
    expect(renderModelSelectWithoutProvider('v2')).toContain('Select model');
  });

  it('shows automatic model selection for local CLI subscriptions', () => {
    expect(renderLocalCLIModelSelect('legacy')).toContain('Auto-selected');
    expect(renderLocalCLIModelSelect('v2')).toContain('Auto-selected');
  });

  it('keeps the normal model prompt for unsupported local-cli combinations', () => {
    expect(renderInvalidLocalCLIModelSelect('legacy')).toContain('Select model');
    expect(renderInvalidLocalCLIModelSelect('v2')).toContain('Select model');
  });
});
