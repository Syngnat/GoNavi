import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AIProviderConfig } from '../../types';

vi.mock('antd', () => ({
  Dropdown: (props: any) => <div data-provider-model-dropdown="true" {...props}>{props.children}</div>,
  Select: (props: any) => <select {...props} />,
}));
vi.mock('@ant-design/icons', () => ({
  CheckOutlined: () => <span data-icon="check" />,
  DownOutlined: () => <span data-icon="down" />,
  LoadingOutlined: () => <span data-icon="loading" />,
  SettingOutlined: () => <span data-icon="settings" />,
}));
import AIChatProviderModelSelect from './AIChatProviderModelSelect';

const provider = (patch: Partial<AIProviderConfig>): AIProviderConfig => ({
  id: 'provider-openai',
  name: 'OpenAI Main',
  type: 'openai',
  apiKey: '',
  hasSecret: true,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
  models: ['gpt-5', 'gpt-5-mini'],
  maxTokens: 0,
  temperature: 0.7,
  ...patch,
});

describe('chat provider and model picker', () => {
  it('renders providers as the first level and enabled models as the second level', async () => {
    const onProviderModelChange = vi.fn();
    const onManageProvider = vi.fn();
    const onFetchProviderModels = vi.fn();
    const providers = [
      provider({ customModels: ['gpt-custom'], disabledModels: ['gpt-5-mini'] }),
      provider({ id: 'provider-grok', name: 'Grok', model: 'grok-4', models: ['grok-4', 'grok-3'] }),
    ];
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <AIChatProviderModelSelect
          activeProvider={providers[0]}
          providers={providers}
          providerModels={{ 'provider-grok': ['grok-4', 'grok-3', 'grok-2'] }}
          dynamicModels={['gpt-5', 'gpt-5-mini', 'gpt-live']}
          loadingModels={false}
          onModelChange={vi.fn()}
          onProviderModelChange={onProviderModelChange}
          onManageProvider={onManageProvider}
          onFetchModels={vi.fn()}
          onFetchProviderModels={onFetchProviderModels}
        />,
      );
    });

    const dropdown = tree!.root.findByProps({ 'data-provider-model-dropdown': 'true' });
    const items = dropdown.props.menu.items;
    expect(items.filter((item: any) => item?.children).map((item: any) => item.label)).toEqual(['OpenAI Main', 'Grok']);
    expect(items[0].children.map((item: any) => item.label)).toEqual(['gpt-5', 'gpt-live', 'gpt-custom']);
    expect(items[1].children.map((item: any) => item.label)).toEqual(['grok-4', 'grok-3', 'grok-2']);
    expect(dropdown.props.menu.selectedKeys).toEqual([items[0].children[0].key]);

    await act(async () => dropdown.props.menu.onClick({ key: items[1].children[1].key }));
    expect(onProviderModelChange).toHaveBeenCalledWith('provider-grok', 'grok-3');

    await act(async () => dropdown.props.menu.onOpenChange([items[1].key]));
    expect(onFetchProviderModels).toHaveBeenCalledWith('provider-grok');

    const manageItem = items.find((item: any) => item?.key === 'manage-models');
    await act(async () => dropdown.props.menu.onClick({ key: manageItem.key }));
    expect(onManageProvider).toHaveBeenCalledWith('provider-openai');
  });

  it('offers automatic selection for a CLI subscription without fetching models on open', async () => {
    const onFetchModels = vi.fn();
    const cli = provider({
      id: 'provider-codex',
      name: 'Codex Subscription',
      type: 'custom',
      apiFormat: 'codex-cli',
      authMode: 'local-cli',
      model: '',
      models: [],
    });
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <AIChatProviderModelSelect
          activeProvider={cli}
          providers={[cli]}
          dynamicModels={[]}
          loadingModels={false}
          onModelChange={vi.fn()}
          onProviderModelChange={vi.fn()}
          onManageProvider={vi.fn()}
          onFetchModels={onFetchModels}
        />,
      );
    });
    const dropdown = tree!.root.findByProps({ 'data-provider-model-dropdown': 'true' });
    expect(dropdown.props.menu.items[0].children).toHaveLength(1);
    await act(async () => dropdown.props.onOpenChange(true));
    expect(onFetchModels).not.toHaveBeenCalled();
  });
});
