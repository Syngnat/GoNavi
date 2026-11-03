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

  // scroll 模式：全部标签都渲染，放不下时横向滚动；「更多」充当索引。
  it('keeps every tab mounted in scroll mode', () => {
    const { container } = render({ overflowMode: 'scroll' });
    measure(260);

    expect(container.querySelectorAll('[data-tab-strip-tab]')).toHaveLength(3);
    const more = container.querySelector('[data-tab-strip-more]');
    expect(more).not.toBeNull();
    // scroll 模式下收纳列全部标签，按钮只给一个索引符号，不显示数字。
    expect(more?.textContent).toBe('⋯');
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
  // fixed 模式（默认）：只渲染放得下的，其余进收纳。
  it('drops the overflow from the strip in fixed mode', () => {
    const describeHiddenTab = vi.fn((key: string) => ({ title: `T-${key}`, meta: `M-${key}` }));
    const { container } = render({ describeHiddenTab, overflowMode: 'fixed' });
    measure(700);

    const described = [...new Set(describeHiddenTab.mock.calls.map(([key]) => key))];
    expect(described).toHaveLength(1);
    expect(container.querySelectorAll('[data-tab-strip-tab]')).toHaveLength(2);
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

  // 回归护栏：菜单项数必须与按钮上的数字一致。
  // 上一版菜单列了全部标签、数字却是「放不下的」数量，两者对不上。
  it('lists exactly as many tabs as the more button announces', () => {
    const { container } = render();
    // 700px 能放下两个 260px 标签，第三个进收纳 —— 这样才验证得了「子集」。
    measure(700);

    const more = container.querySelector<HTMLElement>('[data-tab-strip-more]');
    expect(more).not.toBeNull();
    const announced = Number((more!.textContent || '').replace('+', ''));
    expect(Number.isFinite(announced)).toBe(true);

    act(() => {
      more!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const listed = document.querySelectorAll('[data-tab-more-item]').length;
    expect(listed).toBe(announced);
    // 且必须是真子集：全部塞进收纳就不叫收纳了。
    expect(listed).toBeLessThan(3);
  });

  it('keeps rendering everything before any measurement', () => {
    const { container } = render();
    // 尚未 measure：宽度为 0，全部渲染，避免首帧闪一下。
    expect(container.querySelectorAll('[data-tab-strip-tab]')).toHaveLength(3);
  });
});
