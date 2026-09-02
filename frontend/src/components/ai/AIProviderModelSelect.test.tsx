import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('antd', () => ({
  Select: React.forwardRef((props: any, ref: any) => <><select ref={ref} {...props} />{props.open && props.dropdownRender?.(<div data-menu="options" />)}</>),
  Input: React.forwardRef((props: any, ref: any) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    // rc-input refreshes this handle on every render.
    React.useImperativeHandle(ref, () => ({ input: inputRef.current, focus: () => inputRef.current?.focus() }));
    return <input ref={inputRef} {...props} />;
  }),
  Tooltip: ({ children }: any) => <>{children}</>,
}));
import { Tooltip } from 'antd';
import AIProviderModelSelect, { ModelManagementRow, MODEL_MANAGEMENT_BODY_HEIGHT, MODEL_MANAGEMENT_BODY_HEIGHT_VAR } from './AIProviderModelSelect';
import { t } from '../../i18n/catalog';
import { HINT_TOOLTIP_ENTER_DELAY } from '../common/tooltipTiming';

describe('searchable model selection', () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(async () => { await act(async () => renderer?.unmount()); vi.unstubAllGlobals(); });

  it('opens all candidates for a saved value, supports an explicit custom choice and clears search after selection', async () => {
    const changed = vi.fn();
    await act(async () => {
      renderer = create(<AIProviderModelSelect id="provider-model" aria-describedby="model-help" value="saved" onChange={changed} label="Model" placeholder="Choose" customLabel="Use custom:" options={[{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]} />);
    });
    const select = () => renderer!.root.findByType('select');
    expect(select().props.id).toBe('provider-model');
    expect(select().props['aria-describedby']).toBe('model-help');
    expect(select().props.searchValue).toBe('');
    expect(select().props.options.map((item: any) => item.value)).toEqual(['saved', 'a', 'b']);
    await act(async () => select().props.onSearch('custom-model'));
    expect(changed).not.toHaveBeenCalled();
    expect(select().props.options).toContainEqual({ value: 'custom-model', label: 'Use custom: custom-model' });
    await act(async () => select().props.onChange('custom-model'));
    expect(changed).toHaveBeenCalledWith('custom-model');
    expect(select().props.searchValue).toBe('');
    await act(async () => select().props.onChange(undefined));
    expect(changed).toHaveBeenLastCalledWith('');
  });

  it('does not lose the first typed character when keyboard input opens the dropdown', async () => {
    await act(async () => { renderer = create(<AIProviderModelSelect options={[]} label="Model" placeholder="Choose" customLabel="Use custom:" />); });
    const select = () => renderer!.root.findByType('select');
    await act(async () => { select().props.onSearch('x'); select().props.onOpenChange(true); });
    expect(select().props.searchValue).toBe('x');
    await act(async () => select().props.onBlur());
    expect(select().props.searchValue).toBe('');
  });

  it('manages enabled models while protecting default and SQL models, then updates normal choices', async () => {
    const changed = vi.fn();
    const Harness = () => {
      const [value, setValue] = React.useState('default');
      const [disabled, setDisabled] = React.useState(['hidden']);
      return <AIProviderModelSelect value={value} onChange={(next) => { changed(next); setValue(next); }}
        label="Model" placeholder="CLI default" customLabel="Use custom:" managementRequest={1}
        options={['default', 'fast', 'sql', 'hidden'].map((model) => ({ value: model, label: model }))}
        management={{ defaultModel: value, disabledModels: disabled, completionModel: 'sql', allowDefaultFallback: true,
          copy: (key, params) => t('en-US', key, params), source: 'Fixture catalog',
          onToggle: (model, enabled) => setDisabled((previous) => enabled ? previous.filter((item) => item !== model) : [...previous, model]), onAdd: vi.fn() }} />;
    };
    await act(async () => { renderer = create(<Harness />); });
    const select = () => renderer!.root.findByType('select');
    const toggle = (name: string) => renderer!.root.findByProps({ role: 'switch', 'aria-label': `Enable ${name}` });
    expect(toggle('default').props['aria-disabled']).toBe(true);
    expect(toggle('sql').props['aria-disabled']).toBe(true);
    await act(async () => { toggle('default').props.onClick(); toggle('sql').props.onClick(); });
    expect(toggle('default').props['aria-checked']).toBe(true);
    expect(toggle('sql').props['aria-checked']).toBe(true);
    await act(async () => toggle('fast').props.onClick());
    // Ant Design schedules this close after focus enters the custom popup.
    await act(async () => select().props.onOpenChange(false));
    expect(select().props.open).toBe(true);
    expect(toggle('fast').props['aria-checked']).toBe(false);
    expect(select().props.options.map((option: any) => option.value)).toEqual(['', 'default', 'sql']);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => select().props.onChange('hidden'));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => toggle('hidden').props.onClick());
    expect(select().props.options.map((option: any) => option.value)).toContain('hidden');
    await act(async () => renderer!.root.findByProps({ 'aria-label': 'Set default: hidden' }).props.onClick());
    expect(changed).toHaveBeenLastCalledWith('hidden');
    expect(toggle('hidden').props['aria-disabled']).toBe(true);
    expect(toggle('default').props['aria-disabled']).toBe(false);
    await act(async () => renderer!.root.findByProps({ 'aria-label': 'Close' }).props.onClick());
    expect(select().props.open).toBe(false);
  });

  // Hover hints used to be native `title` attributes: about a second to appear,
  // gone the instant the pointer moved. These now go through antd Tooltip so the
  // shared enter/leave timing applies.
  it('shows model hints through Tooltip with the shared hover timing rather than a native title', async () => {
    await act(async () => {
      renderer = create(<AIProviderModelSelect value="default" onChange={vi.fn()}
        label="Model" placeholder="Choose" customLabel="Use custom:" managementRequest={1}
        options={['default', 'fast'].map((model) => ({ value: model, label: model }))}
        management={{ defaultModel: 'default', disabledModels: [], completionModel: '', allowDefaultFallback: false,
          copy: (key, params) => t('en-US', key, params), source: 'Saved catalog', onToggle: vi.fn(), onAdd: vi.fn() }} />);
    });

    const tooltips = renderer!.root.findAllByType(Tooltip as never);
    expect(tooltips.length).toBeGreaterThan(0);
    tooltips.forEach((tooltip) => {
      expect(tooltip.props.mouseEnterDelay).toBe(HINT_TOOLTIP_ENTER_DELAY);
      expect(tooltip.props.mouseLeaveDelay).toBe(0);
      expect(tooltip.props.overlayClassName).toBe('gonavi-ai-provider-hint-overlay');
    });
    expect(renderer!.root.findByProps({ role: 'switch', 'aria-label': 'Enable default' }).props.title).toBeUndefined();
  });

  // The popup opens above its trigger, so any height change shoves the whole panel
  // up or down. Both tabs therefore render inside one reserved-height box.
  it('renders both tabs inside a single reserved-height body so the popup cannot jump', async () => {
    const Harness: React.FC = () => {
      const [value, setValue] = React.useState('default');
      return <AIProviderModelSelect value={value} onChange={setValue}
        label="Model" placeholder="Choose" customLabel="Use custom:" managementRequest={1}
        options={['default', 'fast'].map((model) => ({ value: model, label: model }))}
        management={{ defaultModel: value, disabledModels: [], completionModel: '', allowDefaultFallback: false,
          copy: (key, params) => t('en-US', key, params), source: 'Saved catalog', onToggle: vi.fn(), onAdd: vi.fn() }} />;
    };
    await act(async () => { renderer = create(<Harness />); });
    const bodies = () => renderer!.root.findAllByProps({ className: 'gonavi-ai-model-management-body' });
    const inactiveTab = () => renderer!.root.findAll((node) => node.type === 'button' && node.props['aria-pressed'] === false)[0];

    expect(bodies()).toHaveLength(1);
    expect(renderer!.root.findByType('select').props.listHeight).toBe(MODEL_MANAGEMENT_BODY_HEIGHT);
    // The stylesheet reads the reserve from this variable, so the number is not duplicated.
    expect(renderer!.root.findByProps({ role: 'dialog' }).props.style[MODEL_MANAGEMENT_BODY_HEIGHT_VAR])
      .toBe(`${MODEL_MANAGEMENT_BODY_HEIGHT}px`);

    // Choosing a default rewrites the option list; the body must still be the only box.
    await act(async () => renderer!.root.findByProps({ 'aria-label': 'Set default: fast' }).props.onClick());
    expect(bodies()).toHaveLength(1);

    await act(async () => inactiveTab().props.onClick());
    expect(bodies()).toHaveLength(1);
    expect(renderer!.root.findByType('select').props.listHeight).toBe(MODEL_MANAGEMENT_BODY_HEIGHT);
  });

  // React.memo can only skip a row while its callbacks keep the same identity.
  it('hands memoized rows callbacks that survive a re-render', async () => {
    const Harness: React.FC = () => {
      const [disabled, setDisabled] = React.useState<string[]>([]);
      return <AIProviderModelSelect value="default" onChange={vi.fn()}
        label="Model" placeholder="Choose" customLabel="Use custom:" managementRequest={1}
        options={['default', 'fast', 'slow'].map((model) => ({ value: model, label: model }))}
        management={{ defaultModel: 'default', disabledModels: disabled, completionModel: '', allowDefaultFallback: true,
          copy: (key, params) => t('en-US', key, params), source: 'Saved catalog',
          onToggle: (model, enabled) => setDisabled((previous) => enabled ? previous.filter((item) => item !== model) : [...previous, model]),
          onAdd: vi.fn() }} />;
    };
    await act(async () => { renderer = create(<Harness />); });
    // React collapses memo(fn) into a SimpleMemoComponent whose fiber type is the
    // inner function, so the tree is searched by that rather than the memo object.
    const rowType = (ModelManagementRow as unknown as { type: React.ComponentType }).type;
    const rows = () => renderer!.root.findAllByType(rowType);
    const before = rows().map((row) => ({ toggle: row.props.onToggle, setDefault: row.props.onSetDefault }));
    expect(before.length).toBe(3);

    await act(async () => renderer!.root.findByProps({ role: 'switch', 'aria-label': 'Enable fast' }).props.onClick());

    const after = rows().map((row) => ({ toggle: row.props.onToggle, setDefault: row.props.onSetDefault }));
    expect(after.map((row) => row.toggle)).toEqual(before.map((row) => row.toggle));
    expect(after.map((row) => row.setDefault)).toEqual(before.map((row) => row.setDefault));
    expect(renderer!.root.findByProps({ role: 'switch', 'aria-label': 'Enable fast' }).props['aria-checked']).toBe(false);
  });

  it('adds custom candidates with Enter without replacing the default or duplicating a disabled name', async () => {
    const added = vi.fn(); const changed = vi.fn();
    await act(async () => { renderer = create(<AIProviderModelSelect value="default" onChange={changed}
      label="Model" placeholder="Choose" customLabel="Use custom:" managementRequest={1}
      options={['default', 'hidden'].map((model) => ({ value: model, label: model }))}
      management={{ defaultModel: 'default', disabledModels: ['hidden'], completionModel: '', allowDefaultFallback: false,
        copy: (key, params) => t('en-US', key, params), source: 'Saved catalog', onToggle: vi.fn(), onAdd: added }} />); });
    const search = () => renderer!.root.findByType('input');
    await act(async () => search().props.onChange({ target: { value: 'new-model' } }));
    await act(async () => search().props.onKeyDown({ key: 'Enter', stopPropagation: vi.fn(), preventDefault: vi.fn() }));
    expect(added).toHaveBeenCalledWith('new-model');
    expect(changed).not.toHaveBeenCalled();
    await act(async () => search().props.onChange({ target: { value: 'HIDDEN' } }));
    await act(async () => search().props.onKeyDown({ key: 'Enter', stopPropagation: vi.fn(), preventDefault: vi.fn() }));
    expect(added).toHaveBeenCalledTimes(1);
    await act(async () => search().props.onKeyDown({ key: 'Escape', stopPropagation: vi.fn() }));
    expect(renderer!.root.findByType('select').props.open).toBe(false);
  });

  it('focuses management once when visible without stealing switch focus on later renders', async () => {
    const focus = vi.fn();
    const node = { offsetWidth: 0, focus };
    let resize: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const renderSelect = (request: number) => <AIProviderModelSelect value="default" label="Model" placeholder="Choose" customLabel="Use custom:"
      managementRequest={request} options={[{ value: 'default', label: 'default' }]}
      management={{ defaultModel: 'default', disabledModels: [], completionModel: '', allowDefaultFallback: false,
        copy: (key, params) => t('en-US', key, params), source: 'Fixture catalog', onToggle: vi.fn(), onAdd: vi.fn() }} />;
    await act(async () => { renderer = create(renderSelect(1), { createNodeMock: (element) => element.type === 'input' ? node : null }); });
    expect(focus).not.toHaveBeenCalled();
    node.offsetWidth = 240;
    await act(async () => resize());
    expect(focus).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
    await act(async () => renderer!.root.findByProps({ role: 'switch' }).props.onClick());
    await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: 'd' } }));
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.root.findByProps({ 'aria-label': 'Close' }).props.onClick());
    await act(async () => renderer!.update(renderSelect(2)));
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
