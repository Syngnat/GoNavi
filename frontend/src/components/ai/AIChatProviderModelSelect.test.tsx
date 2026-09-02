import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AIProviderConfig } from '../../types';

vi.mock('antd', () => ({ Select: (props: any) => <select {...props} /> }));
import AIChatProviderModelSelect from './AIChatProviderModelSelect';

describe('chat model preferences', () => {
  it.each(['legacy', 'v2'] as const)('filters dynamic and saved choices in %s without changing the conversation model', async (variant) => {
    const onModelChange = vi.fn(); const onFetchModels = vi.fn();
    const provider = { id: 'p', name: 'Fixture', type: 'custom', apiFormat: 'codex-cli', authMode: 'local-cli', apiKey: '',
      model: 'previous-conversation-model', models: ['enabled', 'disabled'], disabledModels: ['disabled'], customModels: ['custom'] } as AIProviderConfig;
    let tree: ReturnType<typeof create>;
    for (const dynamicModels of [[], ['remote', 'disabled', 'custom']]) {
      await act(async () => { tree = create(<AIChatProviderModelSelect activeProvider={provider} dynamicModels={dynamicModels} loadingModels={false}
        variant={variant} onModelChange={onModelChange} onFetchModels={onFetchModels} />); });
      const select = tree!.root.findByType('select');
      expect(select.props.options.map((item: any) => item.value)).toEqual(dynamicModels.length ? ['remote', 'custom'] : ['enabled', 'custom']);
      expect(select.props.value).toBe('previous-conversation-model');
      await act(async () => select.props.onOpenChange(true));
      expect(onModelChange).not.toHaveBeenCalled();
      expect(onFetchModels).not.toHaveBeenCalled();
      await act(async () => tree!.unmount());
    }
  });
});
