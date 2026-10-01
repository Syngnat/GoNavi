/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findSettingsEntryElement,
  requestSettingsCenterEntryFocus,
  resetSettingsCenterEntryFocusForTest,
  revealSettingsEntry,
  SETTINGS_CENTER_ENTRY_FLASH_CLASS,
  useSettingsCenterEntryFocus,
} from './settingsCenterEntryFocus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mount = (html: string): HTMLElement => {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
};

describe('findSettingsEntryElement', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('finds a form label written with a trailing colon or asterisk', () => {
    const root = mount('<div class="ant-form-item"><label>* 代理地址：</label><input /></div>');

    expect(findSettingsEntryElement(root, '代理地址')?.tagName).toBe('LABEL');
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    const root = mount('<div><span>  Font   Size </span></div>');

    expect(findSettingsEntryElement(root, 'font size')?.tagName).toBe('SPAN');
  });

  it('picks the innermost element carrying exactly that text', () => {
    const root = mount('<div id="outer"><div id="mid"><span id="leaf">端口</span></div></div>');

    expect(findSettingsEntryElement(root, '端口')?.id).toBe('leaf');
  });

  it('does not match text that merely contains the label', () => {
    const root = mount('<p>代理地址用于访问外部网络并转发请求，请谨慎填写</p>');

    expect(findSettingsEntryElement(root, '代理地址')).toBeNull();
  });

  it('falls back to a control labelled through aria-label, such as a switch', () => {
    const root = mount('<div><button role="switch" aria-label="视图"></button></div>');

    expect(findSettingsEntryElement(root, '视图')?.getAttribute('role')).toBe('switch');
  });

  it('prefers visible text over an aria-label and skips hidden subtrees', () => {
    const root = mount(
      '<div aria-hidden="true"><span>表</span></div><button aria-label="表"></button><span id="visible">表</span>',
    );

    expect(findSettingsEntryElement(root, '表')?.id).toBe('visible');
  });

  it('returns null for empty text or when nothing matches', () => {
    const root = mount('<span>其他</span>');

    expect(findSettingsEntryElement(root, '   ')).toBeNull();
    expect(findSettingsEntryElement(root, '代理地址')).toBeNull();
  });
});

describe('revealSettingsEntry', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('highlights the whole form item and removes the highlight afterwards', () => {
    vi.useFakeTimers();
    const root = mount('<div class="ant-form-item" id="row"><label id="label">端口</label><input /></div>');
    const scroll = vi.fn();
    const label = root.querySelector<HTMLElement>('#label')!;
    label.scrollIntoView = scroll;
    // scrollIntoView is looked up on the highlighted row, so mirror it there.
    const row = root.querySelector<HTMLElement>('#row')!;
    row.scrollIntoView = scroll;

    revealSettingsEntry(label, root);

    expect(row.classList.contains(SETTINGS_CENTER_ENTRY_FLASH_CLASS)).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    vi.advanceTimersByTime(2500);
    expect(row.classList.contains(SETTINGS_CENTER_ENTRY_FLASH_CLASS)).toBe(false);
  });

  it('highlights the row of a switch when the row adds no text of its own', () => {
    const root = mount('<div id="row"><span id="text">视图</span><button aria-label="视图"></button></div>');
    const text = root.querySelector<HTMLElement>('#text')!;

    revealSettingsEntry(text, root);

    expect(root.querySelector('#row')!.classList.contains(SETTINGS_CENTER_ENTRY_FLASH_CLASS)).toBe(true);
  });
});

const nextMacrotask = () => act(async () => {
  await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
});

describe('useSettingsCenterEntryFocus', () => {
  let container: HTMLDivElement;
  let root: Root;

  const Host: React.FC<{ late?: boolean }> = ({ late = false }) => {
    const ref = React.useRef<HTMLDivElement>(null);
    useSettingsCenterEntryFocus(ref);
    return (
      <div ref={ref}>
        <div className="gonavi-settings-center-tree"><span>代理地址</span></div>
        <div className="gonavi-settings-center-content">
          {late ? null : <div className="ant-form-item" id="target"><label>代理地址</label></div>}
        </div>
      </div>
    );
  };

  beforeEach(() => {
    resetSettingsCenterEntryFocusForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetSettingsCenterEntryFocusForTest();
  });

  it('reveals the setting in the content pane, not the menu tree with the same text', async () => {
    act(() => root.render(<Host />));

    act(() => requestSettingsCenterEntryFocus({ text: '代理地址' }));
    await nextMacrotask();

    expect(container.querySelector('#target')?.classList.contains(SETTINGS_CENTER_ENTRY_FLASH_CLASS)).toBe(true);
    expect(container.querySelector('.gonavi-settings-center-tree span')
      ?.classList.contains(SETTINGS_CENTER_ENTRY_FLASH_CLASS)).toBe(false);
  });

  it('waits for a page that renders after the request', async () => {
    act(() => root.render(<Host late />));
    act(() => requestSettingsCenterEntryFocus({ text: '代理地址' }));
    await nextMacrotask();
    expect(container.querySelector('#target')).toBeNull();

    const Late: React.FC = () => (
      <div className="ant-form-item" id="target"><label>代理地址</label></div>
    );
    await act(async () => {
      const content = container.querySelector('.gonavi-settings-center-content')!;
      const lateRoot = createRoot(content);
      lateRoot.render(<Late />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('#target')?.classList.contains(SETTINGS_CENTER_ENTRY_FLASH_CLASS)).toBe(true);
  });

  it('applies a request made before the host mounted', async () => {
    requestSettingsCenterEntryFocus({ text: '代理地址' });

    act(() => root.render(<Host />));
    await nextMacrotask();

    expect(container.querySelector('#target')?.classList.contains(SETTINGS_CENTER_ENTRY_FLASH_CLASS)).toBe(true);
  });
});

describe('useSettingsCenterEntryFocus timing', () => {
  it('does not reveal text from the page being left before the navigation commits', async () => {
    resetSettingsCenterEntryFocusForTest();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const Host: React.FC<{ page: 'a' | 'b' }> = ({ page }) => {
      const ref = React.useRef<HTMLDivElement>(null);
      useSettingsCenterEntryFocus(ref);
      return (
        <div ref={ref}>
          <div className="gonavi-settings-center-content">
            {page === 'a'
              ? <label id="old-page">端口</label>
              : <label id="new-page">端口</label>}
          </div>
        </div>
      );
    };
    act(() => root.render(<Host page="a" />));

    // Same tick: ask for the setting, then switch page like a menu click does.
    act(() => {
      requestSettingsCenterEntryFocus({ text: '端口' });
      root.render(<Host page="b" />);
    });
    await nextMacrotask();

    expect(container.querySelector('#new-page')?.classList.contains(SETTINGS_CENTER_ENTRY_FLASH_CLASS)).toBe(true);
    expect(container.querySelector('#old-page')).toBeNull();
    act(() => root.unmount());
    container.remove();
    resetSettingsCenterEntryFocusForTest();
  });
});
