// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabData } from '../../types';
import {
  createWorkbenchTabOverflowMore,
  mergeWorkbenchTabOverflowPopupClassName,
  renderWorkbenchTabBar,
  TabOverflowMenu,
} from './TabOverflowMenu';
import { closeWorkbenchTabOverflowPopup } from './tabOverflowModel';

const TABS: TabData[] = [
  { id: 'tab-query', title: '新建查询', type: 'query', connectionId: 'conn-1' },
  { id: 'tab-plugin', title: '插件', type: 'plugin-manager', connectionId: '' },
];

describe('TabOverflowMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderMenu = async (onActivate = vi.fn(), onClose = vi.fn()) => {
    await act(async () => {
      root.render(
        <TabOverflowMenu
          tabs={TABS}
          activeTabId="tab-plugin"
          connections={[]}
          connectionGroupNameById={new Map()}
          onActivate={onActivate}
          onClose={onClose}
        />,
      );
    });
    return { onActivate, onClose };
  };

  it('renders a searchable compact list instead of tab cards', async () => {
    await renderMenu();
    const menu = container.querySelector('[data-testid="gn-v2-tab-overflow-menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.querySelector('.gn-v2-tab-label')).toBeNull();
    expect(menu?.querySelector('.ant-tabs-tab')).toBeNull();
    expect(menu?.querySelector('.ant-input')).toBeNull();
    expect(container.querySelector('.gn-v2-tab-overflow-kind')?.textContent?.trim()).toBe('');
    expect(container.querySelector('.gn-v2-tab-overflow-kind .gn-icon-sql-doc')).not.toBeNull();
    expect(container.querySelector('.gn-v2-tab-overflow-kind .gn-icon-package')).not.toBeNull();
    expect([...container.querySelectorAll('.gn-v2-tab-overflow-title')].map((node) => node.textContent)).toEqual([
      'New query',
      'Plugins',
    ]);
    expect([...container.querySelectorAll('.gn-v2-tab-overflow-subtitle')].map((node) => node.textContent)).toEqual([
      'SQL',
      'PLUGIN',
    ]);
    expect(container.querySelector('.gn-v2-tab-overflow-item.is-active .gn-v2-tab-overflow-title')?.textContent).toBe('Plugins');
    expect(container.querySelector('.gn-v2-tab-overflow-item')?.firstElementChild?.classList.contains('gn-v2-tab-overflow-close')).toBe(true);
    expect(container.querySelector('input')?.getAttribute('placeholder')).toBe('Search tabs');
  });

  it('filters rows from the search field', async () => {
    await renderMenu();
    const input = container.querySelector('input');
    if (!input) throw new Error('search input missing');
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      input.focus();
      nativeSetter?.call(input, 'plugin');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'plugin' }));
    });
    expect([...container.querySelectorAll('.gn-v2-tab-overflow-title')].map((node) => node.textContent)).toEqual([
      'Plugins',
    ]);
  });

  it('activates a row and closes a tab from the compact list', async () => {
    const { onActivate, onClose } = await renderMenu();
    const queryButton = container.querySelector('.gn-v2-tab-overflow-item-main');
    if (!(queryButton instanceof HTMLButtonElement)) throw new Error('row missing');
    await act(async () => queryButton.click());
    expect(onActivate).toHaveBeenCalledWith('tab-query');

    const closeButtons = container.querySelectorAll('.gn-v2-tab-overflow-close');
    await act(async () => {
      (closeButtons[1] as HTMLButtonElement).click();
    });
    expect(onClose).toHaveBeenCalledWith('tab-plugin');
  });

  it('keeps antd hash classes and pins the popup as an absolute dropdown', () => {
    expect(mergeWorkbenchTabOverflowPopupClassName('css-dev-only-do-not-override-abc gn-v2-tab-overflow-popup'))
      .toBe('css-dev-only-do-not-override-abc gn-v2-tab-overflow-popup gn-v2-tab-overflow-popup');
    expect(mergeWorkbenchTabOverflowPopupClassName(undefined)).toBe('gn-v2-tab-overflow-popup');

    const more = createWorkbenchTabOverflowMore({
      tabs: TABS,
      connections: [],
      connectionGroupNameById: new Map(),
      onActivate: vi.fn(),
      onClose: vi.fn(),
    }, 'Show hidden tabs');
    expect(more.getPopupContainer?.(document.createElement('div'))).toBe(document.body);
    expect(more.overlayStyle).toEqual({ position: 'absolute' });
    expect(more.minOverlayWidthMatchTrigger).toBe(false);
    expect(React.isValidElement(more.overlay)).toBe(true);
    expect(typeof renderWorkbenchTabBar).toBe('function');
  });

  it('closes the overflow popup by clicking the expanded more button', async () => {
    const button = document.createElement('button');
    button.className = 'ant-tabs-nav-more';
    button.setAttribute('aria-expanded', 'true');
    const tabs = document.createElement('div');
    tabs.className = 'gn-v2-main-tabs';
    tabs.append(button);
    document.body.append(tabs);

    let clicked = 0;
    button.addEventListener('click', () => {
      clicked += 1;
    });

    closeWorkbenchTabOverflowPopup();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(clicked).toBe(1);
    tabs.remove();
  });
});
