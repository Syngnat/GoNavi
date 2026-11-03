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

  // 溢出时收起多余项，并出现「更多」按钮；按钮上只显示数字，宽度稳定。
  it('collapses the overflow behind a compact more button', () => {
    const { container } = render();
    // 260px 时按最小宽度 112 只放得下 1~2 个，「更多」必须出现。
    measure(260);

    const visible = container.querySelectorAll('[data-tab-strip-tab]');
    expect(visible.length).toBeLessThan(3);
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

  // 「更多」菜单的标题与元信息由 describeHiddenTab 提供，是单行布局的数据源。
  it('describes hidden tabs for the more menu', () => {
    const describeHiddenTab = vi.fn((key: string) => ({ title: `T-${key}`, meta: `M-${key}` }));
    render({ describeHiddenTab });
    measure(260);

    expect(describeHiddenTab).toHaveBeenCalled();
    const describedKey = describeHiddenTab.mock.calls[0]![0];
    expect(describedKey).toMatch(/^[abc]$/);
  });

  it('keeps rendering everything before any measurement', () => {
    const { container } = render();
    // 尚未 measure：宽度为 0，全部渲染，避免首帧闪一下。
    expect(container.querySelectorAll('[data-tab-strip-tab]')).toHaveLength(3);
  });
});
