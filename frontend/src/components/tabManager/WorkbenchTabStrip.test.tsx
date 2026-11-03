/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchTabStrip } from './WorkbenchTabStrip';

const t = (key: string) => key;

const render = (props: Partial<React.ComponentProps<typeof WorkbenchTabStrip>> = {}) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const items = props.items ?? [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C' },
  ];
  act(() => {
    root.render(
      <WorkbenchTabStrip
        items={items}
        activeKey="a"
        onTabClick={() => undefined}
        describeHiddenTab={(key) => ({ title: `title-${key}`, meta: `meta-${key}` })}
        t={t}
        {...props}
      />,
    );
  });
  return { container, root, items };
};

describe('WorkbenchTabStrip', () => {
  let resizeCallback: ResizeObserverCallback | null = null;

  beforeEach(() => {
    resizeCallback = null;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // 让标签条拿到一个确定的宽度，避免依赖 jsdom 的布局能力。
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const measure = (width: number) => {
    act(() => {
      resizeCallback?.(
        [{ contentRect: { width } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
  };

  it('renders every tab when the strip is wide enough', () => {
    const { container } = render();
    measure(2000);

    expect(container.querySelectorAll('[data-tab-strip-tab]')).toHaveLength(3);
    expect(container.querySelector('[data-tab-strip-more]')).toBeNull();
  });

  it('marks the active tab', () => {
    const { container } = render({ activeKey: 'b' });
    measure(2000);

    const active = container.querySelector('[data-tab-strip-tab="b"]');
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(active?.className).toContain('is-active');
    expect(
      container.querySelector('[data-tab-strip-tab="a"]')?.getAttribute('aria-selected'),
    ).toBe('false');
  });

  // 规格：标签固定宽度不压缩、全部渲染，放不下时横向滚动；「更多」只做
  // 收纳入口，不再把标签从 DOM 里摘掉。
  it('keeps every tab mounted and exposes a more button when overflowing', () => {
    const { container } = render();
    measure(260);

    expect(container.querySelectorAll('[data-tab-strip-tab]')).toHaveLength(3);
    const more = container.querySelector('[data-tab-strip-more]');
    expect(more).not.toBeNull();
    expect(more?.textContent).toMatch(/^\d+\+?$/);
  });

  it('clicking a visible tab reports its key', () => {
    const onTabClick = vi.fn();
    const { container } = render({ onTabClick });
    measure(2000);

    act(() => {
      container.querySelector<HTMLElement>('[data-tab-strip-tab="b"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onTabClick).toHaveBeenCalledTimes(1);
    expect(onTabClick.mock.calls[0]![0]).toBe('b');
  });

  // 收纳区只描述「放不下」的那批，这一点由 tabOverflowLayout 的纯函数
  // 用例覆盖（组件层依赖 ResizeObserver 时序，不适合断言精确数量）。
  it('describes the overflow tabs for the more menu', () => {
    const describeHiddenTab = vi.fn((key: string) => ({ title: `T-${key}`, meta: `M-${key}` }));
    const { container } = render({ describeHiddenTab });
    measure(260);

    expect([...new Set(describeHiddenTab.mock.calls.map(([key]) => key))].length).toBeGreaterThan(0);
    // 标签条本身仍然渲染全部（供横向滚动），两者不矛盾。
    expect(container.querySelectorAll('[data-tab-strip-tab]')).toHaveLength(3);
  });

  // 「更多」菜单每行左侧要有独立的关闭叉：点它只关闭，不切换过去再关。
  it('offers a close button on every more-menu row', () => {
    const onCloseTab = vi.fn();
    const { container } = render({ onCloseTab });
    measure(260);

    // Dropdown 是懒渲染：先点开「更多」，菜单内容才会挂到 body 上。
    act(() => {
      container.querySelector<HTMLElement>('[data-tab-strip-more]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const closeButtons = document.querySelectorAll('[data-tab-more-close]');
    expect(closeButtons.length).toBeGreaterThan(0);
    const first = closeButtons[0] as HTMLElement;
    const key = first.getAttribute('data-tab-more-close');
    expect(key).toBeTruthy();

    act(() => {
      first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onCloseTab).toHaveBeenCalledWith(key);
  });

  // 设置中心固定在首位、不可排序，内容也短，不需要普通标签那么宽。
  it('renders the pinned settings tab narrower than the others', () => {
    const { container } = render({
      items: [
        { key: 'settings-center', label: 'S' },
        { key: 'a', label: 'A' },
      ],
    });
    measure(2000);

    const settings = container.querySelector<HTMLElement>('[data-tab-strip-tab="settings-center"]');
    const normal = container.querySelector<HTMLElement>('[data-tab-strip-tab="a"]');
    expect(parseFloat(settings!.style.width)).toBeLessThan(parseFloat(normal!.style.width));
  });

  it('keeps rendering everything before any measurement', () => {
    const { container } = render();
    // 尚未 measure：宽度为 0，全部渲染，避免首帧闪一下。
    expect(container.querySelectorAll('[data-tab-strip-tab]')).toHaveLength(3);
  });
});
