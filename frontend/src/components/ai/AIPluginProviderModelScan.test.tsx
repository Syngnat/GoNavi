// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ PluginInvoke: vi.fn() }));
vi.mock('../../../wailsjs/go/app/App', () => host);
vi.mock('../../i18n/runtime', () => ({ syncLanguageRuntime: vi.fn(async () => undefined) }));

import { I18nProvider } from '../../i18n/provider';
import { loadCatalog } from '../../i18n/catalog';
import { t as translate } from '../../i18n';
import { indexModelCatalog } from '../../utils/modelsDevCatalog';
import AIPluginProviderModelScan from './AIPluginProviderModelScan';

const PLUGIN_ID = 'com.gonavi.hualong-ai';
const catalog = indexModelCatalog([
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200_000 },
]);

// I18nProvider renders null until the catalog registry is primed, so load it before mounting.
beforeAll(async () => { await loadCatalog('en-US'); });

const wrap = (data: unknown) => ({ success: true, message: '', data: { ok: true, data } });

let container: HTMLDivElement;
let root: Root;

const copy = (key: string, params?: Record<string, string | number>) => translate(key, params) as string;

const chipLabels = () => [...container.querySelectorAll('.gn-model-chip')]
  .map((chip) => (chip.textContent ?? '').replace('✓', ''));
const buttonByText = (label: string) => [...container.querySelectorAll('button')]
  .find((item) => (item.textContent ?? '').includes(label) || item.getAttribute('aria-label') === label);
const click = async (label: string) => {
  const button = buttonByText(label);
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => { button.click(); });
};
// React 的受控输入只认原生 setter 触发的 input 事件。
const typeInto = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const mount = (props: {
  selected?: string[];
  declared?: Array<{ id: string; name: string; contextWindow: number }>;
  onChange?: (models: string[]) => void;
  catalog?: Map<string, { id: string; name: string; contextWindow: number }>;
} = {}) => act(async () => {
  root.render(
    <I18nProvider preference="en-US" onPreferenceChange={() => undefined}>
      <AIPluginProviderModelScan
        pluginId={PLUGIN_ID}
        t={copy}
        selected={props.selected ?? []}
        declared={props.declared}
        catalog={props.catalog ?? catalog}
        onChange={props.onChange ?? (() => undefined)}
      />
    </I18nProvider>,
  );
});

beforeEach(() => {
  host.PluginInvoke.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AIPluginProviderModelScan', () => {
  it('labels a scanned model with the gateway metadata and falls back to the catalog', async () => {
    host.PluginInvoke.mockResolvedValue(wrap({ state: 'ready', items: [
      { id: 'glm-5.3', name: 'GLM 5.3 (网关)', contextWindow: 1_000_000, keyIds: [1] },
      { id: 'claude-sonnet-4-5', keyIds: [1] },
      { id: 'private-alias', keyIds: [1] },
    ] }));
    const onChange = vi.fn();
    await mount({ onChange });
    await click('Fetch all models');
    expect(chipLabels()).toEqual(['GLM 5.3 (网关) · 1M', 'Claude Sonnet 4.5 · 200K', 'private-alias']);
    expect(onChange).toHaveBeenCalledWith(['glm-5.3', 'claude-sonnet-4-5', 'private-alias']);
  });

  it('keeps the plugin declared name when the catalog knows the model but the gateway does not name it', async () => {
    host.PluginInvoke.mockResolvedValue(wrap({ state: 'ready', items: [{ id: 'glm-5.3', keyIds: [1] }] }));
    await mount({
      declared: [{ id: 'glm-5.3', name: '声明的 GLM', contextWindow: 0 }],
      selected: ['glm-5.3'],
    });
    expect(chipLabels()).toEqual(['声明的 GLM · 1M']);
  });

  it('scan result is a union with selected ids so manual ids survive', async () => {
    host.PluginInvoke.mockResolvedValue(wrap({ state: 'ready', items: [{ id: 'glm-5.3', keyIds: [1] }] }));
    const onChange = vi.fn();
    await mount({ selected: ['my-private-model'], onChange });
    await click('Fetch all models');
    expect(onChange).toHaveBeenCalledWith(['glm-5.3', 'my-private-model']);
    expect(chipLabels()).toContain('my-private-model');
  });

  it('adds a hand-typed model id and selects it', async () => {
    const onChange = vi.fn();
    await mount({ onChange });
    const input = container.querySelector('.gn-model-scan-input') as HTMLInputElement;
    await typeInto(input, ' private-alias ');
    await click('Add model ID');
    expect(onChange).toHaveBeenCalledWith(['private-alias']);
    expect(chipLabels()).toEqual(['private-alias']);
  });

  it('selects and clears the whole list', async () => {
    host.PluginInvoke.mockResolvedValue(wrap({ state: 'ready', items: [
      { id: 'glm-5.3', keyIds: [1] },
      { id: 'claude-sonnet-4-5', keyIds: [1] },
    ] }));
    const onChange = vi.fn();
    await mount({ selected: ['glm-5.3'], onChange });
    await click('Fetch all models');
    await click('Select all');
    expect(onChange).toHaveBeenLastCalledWith(['glm-5.3', 'claude-sonnet-4-5']);
    await click('Clear');
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('says the catalog is unavailable instead of inventing names', async () => {
    await mount({ catalog: new Map() });
    expect(container.querySelector('.gn-model-scan-source')?.textContent)
      .toContain('The models.dev catalog is unavailable');
  });
});
