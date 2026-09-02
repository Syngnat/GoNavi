import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

const bridge = vi.hoisted(() => ({ capabilities: vi.fn(), models: vi.fn() }));
vi.mock('../../../wailsjs/go/aiservice/Service', () => ({ AIGetCLICapabilities: bridge.capabilities, AIGetCLIModelCatalog: bridge.models }));
vi.mock('@ant-design/icons', () => Object.fromEntries([
  'ApiOutlined', 'AppstoreOutlined', 'CheckOutlined', 'DeleteOutlined', 'EditOutlined', 'EyeInvisibleOutlined', 'EyeOutlined', 'KeyOutlined', 'LinkOutlined',
  'LoadingOutlined', 'PlusOutlined', 'RobotOutlined', 'SearchOutlined', 'CloudOutlined', 'ExperimentOutlined', 'ThunderboltOutlined', 'InfoCircleOutlined',
  'DownOutlined', 'RightOutlined', 'LeftOutlined', 'CloseOutlined',
].map((name) => [name, () => <i aria-hidden="true" />])));
vi.mock('antd', () => {
  const Input = Object.assign((props: any) => <input {...props} />, { Password: (props: any) => <input {...props} /> });
  const Form = Object.assign(({ children, ...props }: any) => <form {...props}>{children}</form>, {
    Item: ({ children, name, label, extra }: any) => <div data-field={name}>{label}{children}{extra}</div>,
    useWatch: (name: string, options: any) => (options.form || options).getFieldValue(name),
  });
  return {
    Form, Input,
    Select: React.forwardRef((props: any, ref: any) => <select ref={ref} {...props} />),
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Space: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Tooltip: ({ children }: any) => <>{children}</>,
    // Kept as an element so tests can reach onConfirm without a real popup.
    Popconfirm: ({ children, ...props }: any) => <span data-popconfirm="true" {...props}>{children}</span>,
    // Flatten the dropdown so its menu entries stay reachable as plain buttons.
    Dropdown: Object.assign(({ children }: any) => <>{children}</>, {
      Button: ({ children, menu, ...props }: any) => <>
        <button {...props} data-dropdown-main="true">{children}</button>
        {(menu?.items || []).map((item: any) => (
          <button key={item.key} data-dropdown-item={item.key} disabled={item.disabled}
            onClick={() => menu.onClick?.({ key: item.key })}>{item.label}</button>
        ))}
      </>,
    }),
  };
});
import AISettingsProvidersSection, { REVEAL_ERROR_SELECTOR, revealFirstErrorIn } from './AISettingsProvidersSection';
import { findPreset, PROVIDER_PRESETS } from './aiSettingsModalConfig';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const presets = [
  { key: 'codex', fixedApiFormat: 'codex-cli', label: 'Codex Subscription', authMode: 'local-cli', backendType: 'custom', defaultBaseUrl: '', desc: '', icon: null },
  { key: 'grok', fixedApiFormat: 'grok-cli', label: 'Grok Subscription', authMode: 'local-cli', backendType: 'custom', defaultBaseUrl: '', desc: '', icon: null },
];
const capability = { apiFormat: 'grok-cli', command: 'grok', supportsModelDiscovery: true, supportsEffort: true, effortValues: ['low', 'high'], effortValuesVerified: true, defaultModel: 'configured-model', defaultEffort: 'high' };
const renderedText = (node: any): string => typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(renderedText).join(' ') : renderedText(node?.children || []);
// Field hints now live in one hover icon per heading rather than as note blocks in
// the flow, so their text is read off the Tooltip title instead of the rendered tree.
const elementText = (node: any): string => node === null || node === undefined || node === false || node === true ? ''
  : typeof node === 'string' || typeof node === 'number' ? String(node)
    : Array.isArray(node) ? node.map(elementText).join(' ') : elementText(node?.props?.children);

describe('provider settings mounted controls', () => {
  let renderer: ReactTestRenderer | undefined;
  let props: any;
  let values: Record<string, unknown>;
  let stored: Map<string, string>;
  const layoutKey = 'gonavi.ai.providers.layout.v1';
  const render = async (patch: Record<string, unknown> = {}) => {
    props = { ...props, ...patch };
    await act(async () => {
      if (renderer) renderer.update(<AISettingsProvidersSection {...props} />);
      else renderer = create(<AISettingsProvidersSection {...props} />);
    });
  };
  const modelPickers = () => renderer!.root.findAll((node) => node.type === 'select' && node.props.className === 'gonavi-ai-model-select');
  const rows = () => renderer!.root.findAll((node) => node.type === 'button' && node.props.className === 'gonavi-ai-provider-select');
  const addSelector = () => renderer!.root.findAll((node) => node.type === 'select' && node.props.className?.includes('gonavi-ai-provider-add-preset-select'))[0];
  const endpointSelector = () => renderer!.root.findAll((node) => node.type === 'select' && node.props.className === 'gonavi-ai-provider-endpoint-select')[0];
  const chooseEndpoint = async (endpoint: string) => { await act(async () => endpointSelector().props.onChange(endpoint)); };
  const connectionDetails = () => renderer!.root.findByProps({ className: 'gonavi-ai-cli-details' });
  const hiddenFolder = () => renderer!.root.findByProps({ className: 'gonavi-ai-provider-hidden-toggle' });
  const visibilityAction = (label: string) => renderer!.root.findByProps({ 'aria-label': label });
  const hintText = () => renderer!.root.findAll((node) => node.props?.title?.props?.className === 'gonavi-ai-provider-hint-body')
    .map((node) => elementText(node.props.title)).join(' ');
  beforeEach(() => {
    vi.resetAllMocks();
    stored = new Map();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => stored.set(key, value) } });
    bridge.capabilities.mockResolvedValue([capability]);
    bridge.models.mockResolvedValue({ models: ['discovered-model'], source: 'cli', stale: false });
    values = { model: 'typed-model', models: ['my-model'], effort: 'low' };
    props = {
      providers: [
        { id: 'b', name: 'Work alias', type: 'custom', apiFormat: 'codex-cli', authMode: 'local-cli', model: 'model-b' },
        { id: 'a', name: 'Personal alias', type: 'custom', apiFormat: 'grok-cli', authMode: 'local-cli', model: 'model-a' },
      ],
      activeProviderId: 'b', editingProvider: null, isEditing: false,
      form: { getFieldValue: vi.fn((key) => values[key]), setFieldValue: vi.fn(), setFieldsValue: vi.fn() },
      providerPresets: presets, watchedPresetKey: 'grok', watchedApiFormat: 'grok-cli',
      loading: false, testing: false, testStatus: 'idle', primaryPasswordVisible: false,
      darkMode: false, overlayTheme: buildOverlayWorkbenchTheme(false), cardBg: '#fff', cardBorder: '#ddd', inputBg: '#fff',
      onPrimaryPasswordVisibleChange: vi.fn(), resolveProviderPreset: (provider: any) => ({ key: provider.apiFormat === 'codex-cli' ? 'codex' : 'grok', label: provider.apiFormat === 'codex-cli' ? 'Codex Subscription' : 'Grok Subscription', icon: null }),
      resolvePresetByKey: (key: string) => presets.find((preset) => preset.key === key),
      onAddProvider: vi.fn(), onEditProvider: vi.fn(), onDeleteProvider: vi.fn(), onSetActiveProvider: vi.fn(), onCancelEdit: vi.fn(),
      onPresetChange: vi.fn(), onTestProvider: vi.fn(), onSaveProvider: vi.fn(), onValuesChange: vi.fn(), onCLIDefaults: vi.fn(),
    };
  });
  afterEach(async () => { await act(async () => { renderer?.unmount(); }); renderer = undefined; vi.unstubAllGlobals(); });

  // The reveal must move only the editor's own scrollTop: scrollIntoView would also
  // scroll the overflow-hidden settings panes, which then cannot be scrolled back.
  it('scrolls only its own container and reports when there is no error', () => {
    const scrollTo = vi.fn();
    const container = {
      scrollTop: 40, clientHeight: 300, scrollTo,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelector: vi.fn(() => ({ getBoundingClientRect: () => ({ top: 520, height: 40 }) })),
    };

    expect(revealFirstErrorIn(container)).toBe(true);
    expect(container.querySelector).toHaveBeenCalledWith(REVEAL_ERROR_SELECTOR);
    // 40 + (520 - 100) - (300 - 40) / 2 = 330
    expect(scrollTo).toHaveBeenCalledWith({ top: 330, behavior: 'smooth' });

    expect(revealFirstErrorIn({ ...container, querySelector: () => null })).toBe(false);
    expect(revealFirstErrorIn(null)).toBe(false);
    // Both antd field errors and the standalone alerts must be reachable.
    expect(REVEAL_ERROR_SELECTOR).toContain('.ant-form-item-has-error');
    expect(REVEAL_ERROR_SELECTOR).toContain('[role="alert"]');
  });

  it('never scrolls above the top of its container', () => {
    const scrollTo = vi.fn();
    revealFirstErrorIn({
      scrollTop: 0, clientHeight: 300, scrollTo,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelector: () => ({ getBoundingClientRect: () => ({ top: 110, height: 40 }) }),
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('renders collapse carets as icons in a fixed box rather than bare glyphs', async () => {
    await render({ isEditing: false, editingProvider: null });

    const carets = renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-caret' });
    expect(carets.length).toBeGreaterThanOrEqual(2);
    for (const caret of carets) {
      expect(caret.props['aria-hidden']).toBe('true');
      // A glyph would render as a string child; an icon renders as an element.
      expect(typeof caret.props.children).not.toBe('string');
    }
  });

  // Deleting a saved configuration is destructive, so the chip corner control must
  // still confirm, and must go quiet while another change is in flight.
  it('deletes a saved configuration from its chip after confirming', async () => {
    await render({ isEditing: false, editingProvider: null });

    const remove = renderer!.root.findByProps({ 'aria-label': 'Delete: Personal alias' });
    expect(remove.props.className).toBe('gonavi-ai-provider-chip-remove');
    expect(remove.props.disabled).toBe(false);
    const confirm = renderer!.root.findAll((node) => node.props?.['data-popconfirm'] === 'true'
      && node.props?.okText === 'Delete' && elementText(node.props.children).length >= 0)
      .find((node) => node.props.children?.props?.['aria-label'] === 'Delete: Personal alias')!;
    expect(confirm.props.title).toBe('Delete this provider?');

    await act(async () => confirm.props.onConfirm());
    expect(props.onDeleteProvider).toHaveBeenCalledWith('a');
    expect(props.onSetActiveProvider).not.toHaveBeenCalled();
    expect(props.onEditProvider).not.toHaveBeenCalled();
  });

  it('disables the chip delete while another provider change is pending', async () => {
    await render({ isEditing: false, editingProvider: null, pendingProviderId: 'b' });

    for (const name of ['Work alias', 'Personal alias']) {
      expect(renderer!.root.findByProps({ 'aria-label': `Delete: ${name}` }).props.disabled).toBe(true);
    }
  });

  // Hints were full-width note blocks between the fields; on a short settings pane
  // they pushed the form out of view. They now collapse into one icon per heading.
  it('collapses field hints into heading icons instead of note blocks in the flow', async () => {
    await render({ isEditing: true, editingProvider: { ...props.providers[1] } });

    for (const dead of ['gonavi-ai-provider-configured-note', 'gonavi-ai-provider-model-hint', 'gonavi-ai-provider-detail-note']) {
      expect(renderer!.root.findAllByProps({ className: dead })).toHaveLength(0);
    }
    const icons = renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-hint' });
    expect(icons.length).toBeGreaterThanOrEqual(2);
    expect(hintText()).toContain('Reuses local CLI sign-in');

    // The icon sits inside a <summary>; clicking it must not toggle that section.
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => icons[icons.length - 1].props.onClick(click));
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(click.stopPropagation).toHaveBeenCalledOnce();
  });

  // Save-as duplicates a configuration. A singleton CLI preset reuses one machine
  // login, so it must not offer the entry at all; multi-instance providers keep it
  // in the save button's dropdown instead of as a second button beside it.
  const apiPreset = { key: 'openai', label: 'OpenAI', backendType: 'openai', defaultBaseUrl: 'https://api.openai.com/v1', desc: '', icon: null };
  const apiProvider = { id: 'c', name: 'Team key', type: 'openai', apiFormat: 'openai', model: 'gpt-4o' };

  it('offers save-as inside the save dropdown for a multi-instance provider', async () => {
    await render({
      providerPresets: [...presets, apiPreset],
      providers: [...props.providers, apiProvider],
      resolveProviderPreset: (provider: any) => ({ key: provider.apiFormat === 'openai' ? 'openai' : 'grok', label: provider.apiFormat === 'openai' ? 'OpenAI' : 'Grok Subscription', icon: null }),
      isEditing: true, editingProvider: { ...apiProvider },
      watchedPresetKey: 'openai', watchedApiFormat: 'openai',
      onSaveProviderAsCopy: vi.fn(),
    });

    const main = renderer!.root.findByProps({ 'data-dropdown-main': 'true' });
    expect(renderedText(main.props.children)).toContain('Save changes');
    expect(main.props.placement).toBe('topRight');
    expect(main.props.overlayClassName).toBe('gonavi-ai-provider-save-as-menu');
    const saveAs = renderer!.root.findByProps({ 'data-dropdown-item': 'save-as' });
    const saveAsText = saveAs.findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children as string);
    expect(saveAsText).toContain('Save as');
    // The hint that used to sit in a hover tooltip now reads inline in the menu.
    expect(saveAsText.some((text) => text.includes('without changing the original'))).toBe(true);

    await act(async () => saveAs.props.onClick());
    expect(props.onSaveProviderAsCopy).toHaveBeenCalledTimes(1);
    expect(props.onSaveProvider).not.toHaveBeenCalled();
  });

  it('drops the save dropdown entirely for a singleton CLI preset', async () => {
    await render({ isEditing: true, editingProvider: { ...props.providers[1] }, onSaveProviderAsCopy: vi.fn() });

    expect(renderer!.root.findAllByProps({ 'data-dropdown-main': 'true' })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ 'data-dropdown-item': 'save-as' })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-save-actions' })).toHaveLength(1);
    expect(props.onSaveProviderAsCopy).not.toHaveBeenCalled();
  });

  it('hides candidates without changing saved providers, the current default or the editing draft', async () => {
    await render({ isEditing: true, editingProvider: { ...props.providers[1] } });
    const original = JSON.stringify(props.providers);
    const originalDraft = JSON.stringify(values);
    await act(async () => visibilityAction('Hide provider: Codex Subscription').props.onClick());
    expect(hiddenFolder().props['aria-expanded']).toBe(false);
    expect(renderer!.root.findAllByProps({ 'aria-label': 'Restore: Codex Subscription' })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-hidden-row' })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ 'aria-label': 'Hide provider: Codex Subscription' })).toHaveLength(0);
    expect(rows()).toHaveLength(2);
    expect(rows()[0].props['aria-checked']).toBe(true);
    expect(JSON.stringify(props.providers)).toBe(original);
    expect(JSON.stringify(values)).toBe(originalDraft);
    for (const callback of ['onAddProvider', 'onEditProvider', 'onDeleteProvider', 'onSetActiveProvider', 'onValuesChange', 'onSaveProvider', 'onTestProvider']) {
      expect(props[callback]).not.toHaveBeenCalled();
    }
    await act(async () => hiddenFolder().props.onClick());
    await act(async () => visibilityAction('Restore: Codex Subscription').props.onClick());
    expect(addSelector().props.options).toEqual([]); // Restoring does not bypass the saved CLI singleton guard.
    expect(renderer!.root.findAllByProps({ 'aria-label': 'Hide provider: Codex Subscription' })).toHaveLength(1);
    expect(rows()[0].props['aria-checked']).toBe(true);
  });

  it('persists hidden choices while keeping the folder collapsed on re-entry', async () => {
    await render();
    await act(async () => visibilityAction('Hide provider: Codex Subscription').props.onClick());
    await act(async () => hiddenFolder().props.onClick());
    expect(hiddenFolder().props['aria-expanded']).toBe(true);
    expect(JSON.parse(stored.get(layoutKey)!).hiddenPresetKeys).toEqual(['codex']);
    await act(async () => renderer!.unmount()); renderer = undefined;
    await render();
    expect(hiddenFolder().props['aria-expanded']).toBe(false);
    expect(renderer!.root.findAllByProps({ 'aria-label': 'Hide provider: Codex Subscription' })).toHaveLength(0);
    expect(rows()).toHaveLength(2);
  });

  it('searches hidden choices without automatically expanding them and restores the matching item', async () => {
    await render({ providers: [] });
    await act(async () => visibilityAction('Hide provider: Codex Subscription').props.onClick());
    const search = renderer!.root.findByProps({ 'aria-label': 'Find a provider' });
    await act(async () => search.props.onChange({ target: { value: 'CODEX' } }));
    expect(hiddenFolder().props['aria-expanded']).toBe(false);
    expect(renderedText(renderer!.toJSON())).toContain('1 matching providers are hidden');
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(['grok']);
    await act(async () => hiddenFolder().props.onClick());
    await act(async () => visibilityAction('Restore: Codex Subscription').props.onClick());
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(['codex', 'grok']);
    expect(renderer!.root.findAllByProps({ 'aria-label': 'Hide provider: Codex Subscription' })).toHaveLength(1);
    expect(props.onAddProvider).not.toHaveBeenCalled();
  });

  it('keeps the hidden drawer open after another hide and can recover every API in its original order', async () => {
    const apis = ['openai', 'deepseek'].map((key) => ({ key, label: key, backendType: 'openai', defaultBaseUrl: '', desc: '', icon: null }));
    await render({ providerPresets: apis, providers: [] });
    await act(async () => visibilityAction('Hide provider: openai').props.onClick());
    await act(async () => hiddenFolder().props.onClick());
    await act(async () => visibilityAction('Hide provider: deepseek').props.onClick());
    expect(hiddenFolder().props['aria-expanded']).toBe(true);
    expect(renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-hidden-row' })).toHaveLength(2);
    expect(addSelector().props.options).toEqual([]);
    expect(addSelector().props.notFoundContent).toContain('Hidden');
    await act(async () => visibilityAction('Restore: deepseek').props.onClick());
    await act(async () => visibilityAction('Restore: openai').props.onClick());
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(['openai', 'deepseek']);
    expect(renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-hidden-toggle' })).toHaveLength(0);
    expect(JSON.parse(stored.get(layoutKey)!).hiddenPresetKeys).toEqual([]);
    expect(props.onSaveProvider).not.toHaveBeenCalled();
  });

  it('does not inspect CLI capabilities for the provider list and filters without switching', async () => {
    await render();
    expect(bridge.capabilities).not.toHaveBeenCalled();
    const search = renderer!.root.findByProps({ 'aria-label': 'Search name, provider or model' });
    await act(async () => { search.props.onChange({ target: { value: 'GROK model-a' } }); });
    expect(rows().map((row) => row.props['aria-label'])).toEqual(['Set as default: Personal alias']);
    expect(props.onSetActiveProvider).not.toHaveBeenCalled();
    await act(async () => { search.props.onChange({ target: { value: '' } }); });
    expect(rows().map((row) => row.props['aria-label'])).toEqual(['Set as default: Work alias', 'Set as default: Personal alias']);
    expect(rows()[0].props['aria-checked']).toBe(true);
    expect(renderedText(renderer!.root.findByProps({ role: 'radiogroup' }))).not.toContain('Grok Subscription');
  });

  it('separates the current provider marker from the pending target', async () => {
    await render({ pendingProviderId: 'a' });
    expect(rows()[0].props['aria-checked']).toBe(true);
    expect(rows()[0].props['aria-busy']).toBe(false);
    expect(rows()[1].props['aria-checked']).toBe(false);
    expect(rows()[1].props['aria-busy']).toBe(true);
    expect(rows().filter((row) => row.props['aria-checked'])).toHaveLength(1);
    expect(renderedText(renderer!.toJSON())).toContain('Default');
  });

  it('excludes configured CLIs from new choices even when search hides their chips, but keeps APIs repeatable', async () => {
    const apiPresets = [
      { key: 'openai', label: 'OpenAI', backendType: 'openai', defaultBaseUrl: '', icon: null },
      { key: 'cursor', label: 'Cursor', backendType: 'custom', fixedApiFormat: 'cursor-agent', defaultBaseUrl: '', icon: null },
      { key: 'codebuddy', label: 'CodeBuddy', backendType: 'custom', fixedApiFormat: 'codebuddy-cli', defaultBaseUrl: '', icon: null },
    ];
    await render({ providerPresets: [...presets, ...apiPresets], providers: [...props.providers,
      { id: 'api-1', name: 'API alias', type: 'openai', apiFormat: 'openai', authMode: 'api-key' },
      { id: 'cursor', name: 'Cursor', type: 'custom', apiFormat: 'cursor-agent', authMode: 'api-key' },
      { id: 'buddy', name: 'Buddy', type: 'custom', apiFormat: 'codebuddy-cli', authMode: 'api-key' },
    ] });
    const search = renderer!.root.findByProps({ 'aria-label': 'Search name, provider or model' });
    await act(async () => search.props.onChange({ target: { value: 'no-matches' } }));
    expect(rows()).toHaveLength(0);
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(['openai', 'cursor']);
    await act(async () => addSelector().props.onChange('codex'));
    expect(props.onAddProvider).not.toHaveBeenCalled();
    await act(async () => addSelector().props.onChange('openai'));
    expect(props.onAddProvider).toHaveBeenCalledWith('openai');
    expect(props.onTestProvider).not.toHaveBeenCalled();
    expect(props.onSaveProvider).not.toHaveBeenCalled();
    expect(bridge.capabilities).not.toHaveBeenCalled();
  });

  it('excludes only the saved Cursor CLI while keeping Cursor cloud API repeatable', async () => {
    const cursorPresets = [
      { key: 'cursor', label: 'Cursor', backendType: 'custom', fixedApiFormat: 'cursor-agent', defaultBaseUrl: '', icon: null },
      { key: 'cursor-cli', label: 'Cursor CLI', backendType: 'custom', fixedApiFormat: 'cursor-cli', authMode: 'local-cli', defaultBaseUrl: '', icon: null },
    ];
    const cloud = { id: 'cloud', name: 'Cloud alias', type: 'custom', apiFormat: 'cursor-agent', authMode: 'api-key' };
    const local = { id: 'local', name: 'Local alias', type: 'custom', apiFormat: 'cursor-cli', authMode: 'local-cli' };
    await render({ providerPresets: cursorPresets, providers: [cloud], resolveProviderPreset: (provider: any) => cursorPresets.find((preset) => preset.fixedApiFormat === provider.apiFormat) });
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(['cursor', 'cursor-cli']);
    await render({ providers: [cloud, local], activeProviderId: 'local' });
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(['cursor']);
    expect(addSelector().props.disabled).toBe(false);
    expect(rows()[1].props['aria-checked']).toBe(true);
    expect(bridge.models).not.toHaveBeenCalled();
    await act(async () => addSelector().props.onChange('cursor-cli'));
    expect(props.onAddProvider).not.toHaveBeenCalled();
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(['cursor']);
  });

  it('offers a CLI again after its saved record is removed', async () => {
    await render();
    expect(addSelector().props.options).toEqual([]);
    await render({ providers: props.providers.filter((provider: any) => provider.id !== 'a') });
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(['grok']);
  });

  it('keeps saved chips visible while editing and changes the default without changing the draft', async () => {
    await render({ isEditing: true, editingProvider: { id: 'a' } });
    expect(rows()).toHaveLength(2);
    const group = renderer!.root.findByProps({ role: 'radiogroup' });
    expect(group.props.className).toBe('gonavi-ai-provider-chips');
    await act(async () => rows()[1].props.onClick());
    expect(props.onSetActiveProvider).toHaveBeenCalledWith('a');
    expect(rows()[0].props['aria-checked']).toBe(true);
    expect(values).toEqual({ model: 'typed-model', models: ['my-model'], effort: 'low' });
    expect(props.onSaveProvider).not.toHaveBeenCalled();
    expect(props.onTestProvider).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ 'data-field': 'model' })).toHaveLength(1);
  });

  it('supports keyboard default selection while retaining the acknowledged marker', async () => {
    await render();
    const preventDefault = vi.fn();
    await act(async () => rows()[0].props.onKeyDown({ key: 'ArrowRight', preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
    expect(props.onSetActiveProvider).toHaveBeenCalledWith('a');
    expect(rows()[0].props['aria-checked']).toBe(true);
    expect(rows()[1].props['aria-checked']).toBe(false);
  });

  it('opens an added CLI from the catalog while excluding it from the add dropdown', async () => {
    await render({ isEditing: true, editingProvider: { id: 'a' } });
    expect(addSelector().props.options).toEqual([]);
    const catalog = renderer!.root.findByProps({ className: 'gonavi-ai-provider-catalog-grid' });
    const grok = catalog.findAllByType('button').find((button) => renderedText(button).includes('Grok Subscription'))!;
    await act(async () => grok.props.onClick());
    expect(props.onEditProvider).toHaveBeenCalledWith(props.providers[1]);
    expect(props.onAddProvider).not.toHaveBeenCalled();
    expect(renderedText(grok)).not.toContain('Added');
    expect(renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-catalog-check' }).length).toBeGreaterThan(0);
    expect(hintText()).toContain('Reuses local CLI sign-in');
  });

  it('blocks a stale new CLI draft after another record has been added', async () => {
    await render({ isEditing: true, editingProvider: { id: '' } });
    expect(renderedText(renderer!.root.findByProps({ role: 'alert' }))).toContain('This CLI is already added');
    const actions = renderer!.root.findByProps({ className: 'gonavi-ai-provider-actions' });
    expect(actions.findAllByType('button').every((button) => button.props.disabled)).toBe(true);
    expect(bridge.capabilities).not.toHaveBeenCalled();
    expect(bridge.models).not.toHaveBeenCalled();
  });

  it('toggles editor disclosures from the whole header and keeps the caret beside the title', async () => {
    await render({ isEditing: true, editingProvider: { id: 'a' } });
    const more = () => renderer!.root.findByProps({ className: 'gonavi-ai-provider-more' });
    const click = () => ({ preventDefault: vi.fn() });
    expect(connectionDetails().props.open).toBe(false);
    expect(more().props.open).toBe(false);
    expect(connectionDetails().findAllByProps({ className: 'gonavi-ai-provider-disclosure-lead' })).toHaveLength(1);
    expect(more().findAllByProps({ className: 'gonavi-ai-provider-disclosure-lead' })).toHaveLength(1);
    expect(connectionDetails().findByProps({ className: 'gonavi-ai-provider-disclosure-lead' }).findAllByProps({ className: 'gonavi-ai-provider-caret' })).toHaveLength(1);
    expect(more().findByProps({ className: 'gonavi-ai-provider-disclosure-lead' }).findAllByProps({ className: 'gonavi-ai-provider-caret' })).toHaveLength(1);
    expect(connectionDetails().findByType('summary').props['aria-expanded']).toBe(false);
    expect(more().findByType('summary').props['aria-expanded']).toBe(false);
    await act(async () => connectionDetails().findByType('summary').props.onClick(click()));
    expect(connectionDetails().props.open).toBe(true);
    expect(connectionDetails().findByType('summary').props['aria-expanded']).toBe(true);
    await act(async () => more().findByType('summary').props.onClick(click()));
    expect(more().props.open).toBe(true);
    expect(more().findByType('summary').props['aria-expanded']).toBe(true);
    await act(async () => connectionDetails().findByType('summary').props.onClick(click()));
    expect(connectionDetails().props.open).toBe(false);
  });

  it('keeps configured CLI details collapsed while model and effort controls remain visible', async () => {
    await render({ isEditing: true, editingProvider: { id: 'a' } });
    expect(connectionDetails().props.open).toBe(false);
    expect(modelPickers()[0].props.options).toContainEqual({ label: 'discovered-model', value: 'discovered-model' });
    expect(renderer!.root.findAllByProps({ 'data-field': 'effort' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ 'data-field': 'name' })).toHaveLength(1);
    expect(props.onCLIDefaults).toHaveBeenCalledWith(capability);
    expect(props.form.setFieldsValue).not.toHaveBeenCalled();
  });

  it('expands CLI details for new configurations or a failed check', async () => {
    await render({ isEditing: true, providers: [], editingProvider: { id: '' } });
    expect(connectionDetails().props.open).toBe(true);
    await render({ editingProvider: { id: 'saved' } });
    expect(connectionDetails().props.open).toBe(false);
    await render({ testStatus: 'error' });
    expect(connectionDetails().props.open).toBe(true);
  });

  it('keeps manual model input and existing values when model discovery fails', async () => {
    bridge.models.mockRejectedValue(new Error('not logged in'));
    await render({ isEditing: true, providers: [], editingProvider: { id: '' } });
    const input = modelPickers()[0];
    expect(input.props.disabled).not.toBe(true);
    expect(hintText()).toContain('You can enter a model manually');
    expect(values).toMatchObject({ model: 'typed-model', models: ['my-model'], effort: 'low' });
    expect(props.form.setFieldsValue).not.toHaveBeenCalled();
  });

  it('ignores late Grok model discovery after selecting another CLI', async () => {
    const old = deferred<any>();
    bridge.models.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ models: ['codex-candidate'], source: 'cache', stale: false });
    await render({ isEditing: true, providers: [], editingProvider: { id: '' } });
    await render({ watchedPresetKey: 'codex', watchedApiFormat: 'codex-cli' });
    await act(async () => { old.resolve({ models: ['stale-grok-model'], source: 'cli', stale: false }); });
    expect(modelPickers()[0].props.options).not.toContainEqual({ value: 'stale-grok-model', label: 'stale-grok-model' });
  });

  it('does not reuse the prior editor session defaults while fresh capabilities are loading', async () => {
    await render({ isEditing: true, providers: [], editingProvider: { id: '' }, editorSessionKey: 1 });
    expect(props.onCLIDefaults).toHaveBeenCalledTimes(1);
    const fresh = deferred<any[]>();
    bridge.capabilities.mockReturnValueOnce(fresh.promise);
    await render({ editorSessionKey: 2 });
    expect(props.onCLIDefaults).toHaveBeenCalledTimes(1);
    await act(async () => { fresh.resolve([{ ...capability, defaultModel: 'fresh-model' }]); });
    expect(props.onCLIDefaults).toHaveBeenLastCalledWith(expect.objectContaining({ defaultModel: 'fresh-model' }));
  });

  it('loads Codex cache candidates even without CLI discovery and shares them across all model controls', async () => {
    bridge.capabilities.mockResolvedValue([{ ...capability, apiFormat: 'codex-cli', supportsModelDiscovery: false }]);
    bridge.models.mockResolvedValue({ models: ['cache-a', 'cache-b'], source: 'cache', stale: false });
    await render({ isEditing: true, editingProvider: { id: 'b' }, watchedPresetKey: 'codex', watchedApiFormat: 'codex-cli' });
    expect(bridge.models).toHaveBeenCalledWith('codex-cli');
    const favorites = renderer!.root.findAll((node) => node.type === 'select' && node.props.mode === 'tags')[0];
    for (const control of [...modelPickers(), favorites]) {
      expect(control.props.options).toEqual(expect.arrayContaining([
        { label: 'cache-a', value: 'cache-a' }, { label: 'cache-b', value: 'cache-b' },
        { label: 'typed-model', value: 'typed-model' }, { label: 'my-model', value: 'my-model' },
      ]));
    }
    expect(values.model).toBe('typed-model');
    expect(props.form.setFieldsValue).not.toHaveBeenCalled();
    expect(hintText()).toContain('local Codex cache');
    expect(connectionDetails().props.open).toBe(false);
  });

  it('discards stale cache candidates without clearing saved settings', async () => {
    bridge.models.mockResolvedValue({ models: ['stale-model'], source: 'cache', stale: true });
    await render({ isEditing: true, editingProvider: { id: 'b' }, watchedPresetKey: 'codex', watchedApiFormat: 'codex-cli' });
    expect(modelPickers()[0].props.options).not.toContainEqual({ value: 'stale-model', label: 'stale-model' });
    expect(modelPickers()[0].props.options).toContainEqual({ value: 'typed-model', label: 'typed-model' });
    expect(hintText()).toContain('catalog is outdated');
    expect(props.form.setFieldsValue).not.toHaveBeenCalled();
  });

  it.each(['', 'claude-pinned-custom'])('offers Claude aliases without overwriting the saved model %j', async (savedModel) => {
    const claudePreset = { key: 'claude-subscription', fixedApiFormat: 'claude-cli', label: 'Claude Subscription', authMode: 'local-cli', backendType: 'custom', defaultBaseUrl: '', desc: '', icon: null };
    const provider = { id: 'claude', name: 'My Claude', type: 'custom', apiFormat: 'claude-cli', authMode: 'local-cli', model: savedModel };
    values.model = savedModel;
    bridge.capabilities.mockResolvedValue([{ ...capability, apiFormat: 'claude-cli', command: 'claude', supportsModelDiscovery: false, defaultModel: '', defaultEffort: '' }]);
    bridge.models.mockResolvedValue({ models: ['sonnet', 'opus', 'haiku'], source: 'aliases', stale: false });
    await render({
      isEditing: true, editingProvider: provider, providers: [provider],
      watchedPresetKey: 'claude-subscription', watchedApiFormat: 'claude-cli',
      providerPresets: [...presets, claudePreset],
      resolvePresetByKey: (key: string) => key === claudePreset.key ? claudePreset : presets.find((preset) => preset.key === key),
      resolveProviderPreset: () => claudePreset,
    });
    expect(bridge.models).toHaveBeenCalledWith('claude-cli');
    const favorites = renderer!.root.findAll((node) => node.type === 'select' && node.props.mode === 'tags')[0];
    for (const control of [...modelPickers(), favorites]) {
      expect(control.props.options).toEqual(expect.arrayContaining(['sonnet', 'opus', 'haiku'].map((value) => ({ label: value, value }))));
      if (savedModel) expect(control.props.options).toContainEqual({ label: savedModel, value: savedModel });
    }
        expect(hintText()).toContain('Common Claude aliases');
    expect(modelPickers()[0].props.placeholder).toContain('CLI default');
    expect(connectionDetails().props.open).toBe(false);
    expect(values.model).toBe(savedModel);
    expect(props.form.setFieldsValue).not.toHaveBeenCalled();
    expect(props.onSaveProvider).not.toHaveBeenCalled();
    expect(props.onTestProvider).not.toHaveBeenCalled();
  });

  it('offers Cursor CLI candidates without overwriting custom models or hiding its native-hook boundary', async () => {
    const cursorPreset = { key: 'cursor-cli', fixedApiFormat: 'cursor-cli', label: 'Cursor CLI', authMode: 'local-cli', backendType: 'custom', defaultBaseUrl: '', desc: '', icon: null };
    const provider = { id: 'cursor-local', name: 'My Cursor', type: 'custom', apiFormat: 'cursor-cli', authMode: 'local-cli', model: 'my-custom-model' };
    values.model = provider.model;
    values.effort = '';
    bridge.capabilities.mockResolvedValue([{ apiFormat: 'cursor-cli', command: 'cursor-agent', supportsModelDiscovery: true, supportsEffort: false, effortValues: [], effortValuesVerified: false, defaultModel: '', defaultEffort: '' }]);
    bridge.models.mockResolvedValue({ models: ['auto', 'account-model'], source: 'cli', stale: false });
    await render({
      isEditing: true, editingProvider: provider, providers: [provider],
      watchedPresetKey: 'cursor-cli', watchedApiFormat: 'cursor-cli', providerPresets: [cursorPreset],
      resolvePresetByKey: () => cursorPreset, resolveProviderPreset: () => cursorPreset,
    });
    expect(bridge.models).toHaveBeenCalledWith('cursor-cli');
    const favorites = renderer!.root.findAll((node) => node.type === 'select' && node.props.mode === 'tags')[0];
    for (const control of [...modelPickers(), favorites]) {
      expect(control.props.options).toEqual(expect.arrayContaining(['auto', 'account-model', 'my-custom-model'].map((value) => ({ label: value, value }))));
    }
    const effort = renderer!.root.findByProps({ 'data-field': 'effort' }).findByType('input');
    expect(effort.props.disabled).toBe(true);
    expect(effort.props.placeholder).toBe('This CLI has no effort selector');
    expect(hintText()).toContain('Native Cursor hooks and plugins can still run');
    expect(connectionDetails().props.open).toBe(false);
    expect(values.model).toBe('my-custom-model');
    expect(props.form.setFieldsValue).not.toHaveBeenCalled();
    expect(props.onSaveProvider).not.toHaveBeenCalled();
    expect(props.onTestProvider).not.toHaveBeenCalled();
  });

  it('renders hidden candidates as compact icon rows and keeps the add control on one heading row', async () => {
    await render({ providers: [] });
    const heading = renderer!.root.findByProps({ className: 'gonavi-ai-provider-heading' });
    expect(renderedText(heading)).toContain('Configure model endpoints and secrets');
    expect(renderedText(heading)).not.toContain('Model providers');
    expect(addSelector().props.showSearch).toBe(true);
    await act(async () => visibilityAction('Hide provider: Codex Subscription').props.onClick());
    await act(async () => hiddenFolder().props.onClick());
    const hiddenRows = renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-hidden-row' });
    expect(hiddenRows).toHaveLength(1);
    expect(renderedText(hiddenRows[0])).toContain('Codex Subscription');
    expect(renderer!.root.findAll((node) => node.type === 'button' && node.props.className?.includes('gonavi-ai-provider-catalog-card')).filter((button) => renderedText(button).includes('Codex Subscription'))).toHaveLength(0);
    expect(hiddenFolder().props.title).toContain('Hidden candidates do not affect saved configurations');
    expect(props.onAddProvider).not.toHaveBeenCalled();
  });

  it('keeps the hidden drawer collapsed after hiding and still exposes the height splitter', async () => {
    await render({ providers: [] });
    await act(async () => visibilityAction('Hide provider: Codex Subscription').props.onClick());
    expect(renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-hidden-split' })).toHaveLength(1);
    expect(hiddenFolder().props['aria-expanded']).toBe(false);
    expect(renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-hidden-row' })).toHaveLength(0);
    expect(JSON.parse(stored.get(layoutKey)!).hiddenPresetKeys).toEqual(['codex']);
    await act(async () => hiddenFolder().props.onClick());
    expect(renderer!.root.findAllByProps({ className: 'gonavi-ai-provider-hidden-row' })).toHaveLength(1);
  });

  it('adds a hidden candidate from the hidden row without restoring it', async () => {
    await render({ providers: [] });
    await act(async () => visibilityAction('Hide provider: Codex Subscription').props.onClick());
    await act(async () => hiddenFolder().props.onClick());
    await act(async () => renderer!.root.findByProps({ className: 'gonavi-ai-provider-hidden-choose' }).props.onClick());
    expect(props.onAddProvider).toHaveBeenCalledWith('codex');
    expect(props.onEditProvider).not.toHaveBeenCalled();
    expect(JSON.parse(stored.get(layoutKey)!).hiddenPresetKeys).toEqual(['codex']);
  });

  it('edits a hidden configured CLI from the hidden row without adding a second copy', async () => {
    await render({ isEditing: true, editingProvider: { id: 'b' } });
    await act(async () => visibilityAction('Hide provider: Grok Subscription').props.onClick());
    await act(async () => hiddenFolder().props.onClick());
    await act(async () => renderer!.root.findByProps({ className: 'gonavi-ai-provider-hidden-choose' }).props.onClick());
    expect(props.onEditProvider).toHaveBeenCalledWith(props.providers[1]);
    expect(props.onAddProvider).not.toHaveBeenCalled();
    expect(JSON.parse(stored.get(layoutKey)!).hiddenPresetKeys).toEqual(['grok']);
  });

  it('keeps catalog search beside the catalog title and hides it when the catalog is collapsed', async () => {
    await render();
    const catalogSearches = () => renderer!.root.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Find a provider');
    const catalogToggle = () => renderer!.root.findByProps({ className: 'gonavi-ai-provider-catalog-toggle' });
    const toolbar = renderer!.root.findByProps({ className: 'gonavi-ai-provider-workspace-toolbar' });
    expect(catalogSearches()).toHaveLength(1);
    expect(toolbar.findByProps({ className: 'gonavi-ai-provider-catalog-toggle' })).toBe(catalogToggle());
    expect(toolbar.findByProps({ className: 'gonavi-ai-provider-catalog-search' })).toBeTruthy();
    expect(catalogToggle().props['aria-expanded']).toBe(true);
    await act(async () => catalogToggle().props.onClick());
    expect(catalogToggle().props['aria-expanded']).toBe(false);
    expect(catalogSearches()).toHaveLength(0);
    await act(async () => catalogToggle().props.onClick());
    expect(catalogSearches()).toHaveLength(1);
  });

  it('keeps a compact preset dropdown for new providers as well as saved providers', async () => {
    await render({ isEditing: true, providers: [], editingProvider: null });
    expect(addSelector().props.showSearch).toBe(true);
    expect(renderer!.root.findAllByProps({ role: 'radiogroup' })).toHaveLength(1);
    const more = renderer!.root.findByProps({ className: 'gonavi-ai-provider-more' });
    expect(more.findAllByProps({ 'data-field': 'models' })).toHaveLength(1);
    expect(more.findAllByProps({ 'data-field': 'inlineCompletionModel' })).toHaveLength(1);
    expect(more.findAllByProps({ 'data-field': 'model' })).toHaveLength(0);
  });

  it('keeps both API protocols selectable and invalidates checks when changing protocol', async () => {
    await render({
      isEditing: true, editingProvider: { id: 'saved' }, watchedPresetKey: 'deepseek', watchedApiFormat: 'openai-responses',
      providerPresets: [...presets, { key: 'deepseek', label: 'DeepSeek', backendType: 'openai', defaultBaseUrl: '', desc: '', icon: null }],
    });
    const protocol = endpointSelector();
    expect(protocol.props.options.map((item: any) => item.value)).toEqual(['openai-responses', 'openai']);
    expect(protocol.props.value).toBe('openai-responses');
    await act(async () => protocol.props.onChange('openai'));
    expect(props.onPresetChange).toHaveBeenCalledWith('deepseek', 'openai');
    expect(props.form.setFieldValue).not.toHaveBeenCalled();
  });

  it('leaves the test button label unchanged and renders the result next to it', async () => {
    await render({ isEditing: true, editingProvider: { id: 'a' }, loading: true, testStatus: 'success', testResult: { success: true, checkKind: 'local-auth', modelVerified: false, message: 'fixture' } });
    // Both handlers are wrapped so a rejected attempt can scroll its error into
    // view, so they are located by label rather than by callback identity.
    const buttons = renderer!.root.findAllByType('button');
    const check = buttons.find((button) => renderedText(button) === 'Test connection')!;
    const save = buttons.find((button) => renderedText(button) === 'Save changes')!;
    expect(check.children).toEqual(['Test connection']);
    expect(check.props.loading).toBe(false);
    expect(save.props.loading).toBe(true);
    await act(async () => { check.props.onClick(); save.props.onClick(); });
    expect(props.onTestProvider).toHaveBeenCalledOnce();
    expect(props.onSaveProvider).toHaveBeenCalledOnce();
    expect(renderedText(renderer!.root.findByProps({ className: 'gonavi-ai-provider-test-result' }))).toContain('model response not verified');
  });

  it('shows the complete catalog and a searchable add dropdown without an endpoint-first step', async () => {
    await render({ providers: [], providerPresets: PROVIDER_PRESETS });
    expect(endpointSelector()).toBeUndefined();
    expect(addSelector().props.disabled).toBe(false);
    expect(addSelector().props.showSearch).toBe(true);
    expect(addSelector().props.options.map((option: any) => option.value)).toEqual(PROVIDER_PRESETS.map((preset) => preset.key));
    const catalog = renderer!.root.findByProps({ className: 'gonavi-ai-provider-catalog-grid' });
    expect(catalog.findAll((node) => node.type === 'button' && node.props.className?.includes('gonavi-ai-provider-catalog-card'))).toHaveLength(PROVIDER_PRESETS.length);
    await act(async () => addSelector().props.onChange('moonshot'));
    expect(props.onAddProvider).toHaveBeenCalledWith('moonshot');
    expect(props.onTestProvider).not.toHaveBeenCalled();
    expect(props.onSaveProvider).not.toHaveBeenCalled();
    expect(props.onSetActiveProvider).not.toHaveBeenCalled();
    expect(bridge.capabilities).not.toHaveBeenCalled();
    expect(bridge.models).not.toHaveBeenCalled();
  });

  it('backfills a saved protocol and limits regional URL choices to that protocol', async () => {
    values.type = 'openai';
    values.baseUrl = 'https://api.minimaxi.com/v1';
    await render({ isEditing: true, editingProvider: { id: 'saved' }, watchedPresetKey: 'minimax', watchedApiFormat: 'openai', providerPresets: PROVIDER_PRESETS, resolvePresetByKey: findPreset });
    expect(endpointSelector().props.value).toBe('openai');
    expect(renderedText(renderer!.root.findByProps({ className: 'gonavi-ai-provider-editor-heading' }))).toContain('MiniMax');
    const urls = renderer!.root.findByProps({ 'data-field': 'baseUrl' }).findByType('select');
    expect(urls.props.options.map((option: any) => option.value)).toEqual(['https://api.minimax.io/v1', 'https://api.minimaxi.com/v1']);
    expect(renderer!.root.findByType('form').props.hidden).not.toBe(true);
    expect(props.onPresetChange).not.toHaveBeenCalled();
    await chooseEndpoint('anthropic');
    expect(props.onPresetChange).toHaveBeenCalledWith('minimax', 'anthropic');
  });

  it('collapses saved providers and restores the chosen compact or normal density', async () => {
    await render();
    const collapse = () => renderer!.root.findByProps({ 'aria-controls': 'gonavi-ai-provider-chips' });
    const density = renderer!.root.findByProps({ 'aria-label': 'Display density' });
    expect(density.findAllByType('button')[0].props['aria-pressed']).toBe(true);
    await act(async () => density.findAllByType('button')[1].props.onClick());
    expect(renderer!.root.findByProps({ className: 'gonavi-ai-provider-list' }).props['data-density']).toBe('normal');
    await act(async () => collapse().props.onClick());
    expect(renderer!.root.findByProps({ role: 'radiogroup' }).props.hidden).toBe(true);
    expect(renderedText(renderer!.toJSON())).toContain('Default: Work alias');
    await act(async () => collapse().props.onClick());
    expect(renderer!.root.findByProps({ role: 'radiogroup' }).props.hidden).toBe(false);
    expect(renderer!.root.findByProps({ className: 'gonavi-ai-provider-list' }).props['data-density']).toBe('normal');
    expect(props.onSetActiveProvider).not.toHaveBeenCalled();
  });

  it('filters the catalog independently and opens API copies without overwriting the current form', async () => {
    await render({ isEditing: true, editingProvider: { id: 'a' }, providerPresets: PROVIDER_PRESETS });
    const original = { ...values };
    const search = renderer!.root.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Find a provider')[0];
    await act(async () => search.props.onChange({ target: { value: 'DeepSeek' } }));
    const catalog = renderer!.root.findByProps({ className: 'gonavi-ai-provider-catalog-grid' });
    const cards = catalog.findAll((node) => node.type === 'button' && node.props.className?.includes('gonavi-ai-provider-catalog-card'));
    expect(cards).toHaveLength(1);
    await act(async () => cards[0].props.onClick());
    expect(props.onAddProvider).toHaveBeenCalledWith('deepseek');
    expect(values).toEqual(original);
    expect(props.form.setFieldValue).not.toHaveBeenCalled();
    expect(props.form.setFieldsValue).not.toHaveBeenCalled();
  });

  it('filters disabled suggestions in both model pickers and preserves their management entries', async () => {
    values.disabledModels = ['discovered-model'];
    values.customModels = ['mine'];
    await render({ isEditing: true, editingProvider: { id: 'a' } });
    for (const picker of modelPickers()) {
      expect(picker.props.options).not.toContainEqual({ label: 'discovered-model', value: 'discovered-model' });
      expect(picker.props.options).toContainEqual({ label: 'mine', value: 'mine' });
    }
    expect(renderedText(renderer!.root.findByProps({ 'data-field': 'model' }))).toContain('4/5 enabled');
    expect(props.onValuesChange).not.toHaveBeenCalled();
    expect(values.disabledModels).toEqual(['discovered-model']);
  });

  it('does not reopen model management in a saved or different editor session', async () => {
    await render({ isEditing: true, editingProvider: { id: 'a' }, editorSessionKey: 1 });
    const preventDefault = vi.fn();
    await act(async () => renderer!.root.findByProps({ 'aria-label': 'Manage models' }).props.onClick({ preventDefault, stopPropagation: vi.fn() }));
    expect(preventDefault).toHaveBeenCalled();
    expect(modelPickers()[0].props.open).toBe(true);
    await render({ editorSessionKey: 2 });
    expect(modelPickers()[0].props.open).toBe(false);
  });
});
