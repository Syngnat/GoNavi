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
    Dropdown: ({
      className,
      children,
      menu,
    }: {
      className?: string;
      children?: React.ReactNode;
      menu?: { items?: Array<{ label?: React.ReactNode; children?: Array<{ label?: React.ReactNode }> }> };
    }) => React.createElement(
      'div',
      { className },
      children,
      menu?.items?.flatMap((item) => [item?.label, ...(item?.children?.map((child) => child.label) || [])]),
    ),
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  return {
    CheckOutlined: () => React.createElement('span', { 'data-icon': 'check' }),
    DownOutlined: () => React.createElement('span', { 'data-icon': 'down' }),
    LoadingOutlined: () => React.createElement('span', { 'data-icon': 'loading' }),
    SettingOutlined: () => React.createElement('span', { 'data-icon': 'settings' }),
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

const renderModelSelect = () => renderToStaticMarkup(
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    <AIChatProviderModelSelect
      activeProvider={baseProvider}
      dynamicModels={[]}
      loadingModels={false}
      onModelChange={() => undefined}
      onFetchModels={() => undefined}
    />
  </I18nProvider>,
);

const renderModelSelectWithoutProvider = () => renderToStaticMarkup(
  <AIChatProviderModelSelect
    activeProvider={baseProvider}
    dynamicModels={[]}
    loadingModels={false}
    onModelChange={() => undefined}
    onFetchModels={() => undefined}
  />,
);

const renderLocalCLIModelSelect = () => renderToStaticMarkup(
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
      onModelChange={() => undefined}
      onFetchModels={() => undefined}
    />
  </I18nProvider>,
);

const renderInvalidLocalCLIModelSelect = () => renderToStaticMarkup(
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
      onModelChange={() => undefined}
      onFetchModels={() => undefined}
    />
  </I18nProvider>,
);

describe('AIChatProviderModelSelect i18n source guards', () => {

  it('renders the localized placeholder', () => {
    expect(renderModelSelect()).toContain('Select model');
  });

  it('falls back to the English placeholder without an i18n provider', () => {
    expect(() => renderModelSelectWithoutProvider()).not.toThrow();
    expect(renderModelSelectWithoutProvider()).toContain('Select model');
  });

  it('shows automatic model selection for local CLI subscriptions', () => {
    expect(renderLocalCLIModelSelect()).toContain('Auto-selected');
  });

  it('keeps the normal model prompt for unsupported local-cli combinations', () => {
    expect(renderInvalidLocalCLIModelSelect()).toContain('Select model');
  });
});
