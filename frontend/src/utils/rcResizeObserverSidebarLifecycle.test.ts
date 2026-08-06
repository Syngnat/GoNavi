import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SIDEBAR_RESIZING_ATTRIBUTE = 'data-sidebar-resizing';
const SIDEBAR_TRANSITIONING_ATTRIBUTE = 'data-sidebar-transitioning';
const SIDEBAR_RESIZE_SETTLED_EVENT = 'gonavi:sidebar-resize-settled';

describe('rc-resize-observer sidebar resize patch', () => {
  let sidebarResizeActive = false;
  let sidebarTransitionActive = false;
  let fakeWindow: EventTarget;

  beforeEach(() => {
    vi.resetModules();
    sidebarResizeActive = false;
    sidebarTransitionActive = false;
    fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', {
      body: {
        getAttribute: (name: string) => (
          (name === SIDEBAR_RESIZING_ATTRIBUTE && sidebarResizeActive)
          || (name === SIDEBAR_TRANSITIONING_ATTRIBUTE && sidebarTransitionActive)
            ? 'true'
            : null
        ),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('coalesces repeated dependency callbacks until the sidebar settles', async () => {
    const { _el, _rs } = await import('rc-resize-observer/es/utils/observerUtil.js');
    const firstTarget = {} as Element;
    const secondTarget = {} as Element;
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    _el.set(firstTarget, new Set([firstListener]));
    _el.set(secondTarget, new Set([secondListener]));

    sidebarResizeActive = true;
    _rs([
      { target: firstTarget },
      { target: firstTarget },
      { target: secondTarget },
    ] as ResizeObserverEntry[]);

    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).not.toHaveBeenCalled();

    sidebarResizeActive = false;
    fakeWindow.dispatchEvent(new Event(SIDEBAR_RESIZE_SETTLED_EVENT));

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(firstListener).toHaveBeenCalledWith(firstTarget);
    expect(secondListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledWith(secondTarget);

    _rs([{ target: firstTarget }] as ResizeObserverEntry[]);
    expect(firstListener).toHaveBeenCalledTimes(2);

    _el.delete(firstTarget);
    _el.delete(secondTarget);
  });

  it('ships the same lifecycle behavior in the install-time patch', () => {
    const patch = readFileSync(
      new URL('../../patches/rc-resize-observer+1.4.3.patch', import.meta.url),
      'utf8',
    );

    expect(patch).toContain("getAttribute(SIDEBAR_RESIZING_ATTRIBUTE) === 'true'");
    expect(patch).toContain("getAttribute(SIDEBAR_TRANSITIONING_ATTRIBUTE) === 'true'");
    expect(patch).toContain('deferredSidebarResizeTargets.add(entity.target)');
    expect(patch).toContain('window.addEventListener(SIDEBAR_RESIZE_SETTLED_EVENT');
    expect(patch).toContain('if (isSidebarResizeActive()) return;');
    expect(patch).toContain('targets.forEach(notifyTarget)');
  });

  it('coalesces dependency callbacks throughout a sidebar collapse transition', async () => {
    const { _el, _rs } = await import('rc-resize-observer/es/utils/observerUtil.js');
    const target = {} as Element;
    const listener = vi.fn();
    _el.set(target, new Set([listener]));

    sidebarTransitionActive = true;
    _rs([{ target }] as ResizeObserverEntry[]);
    expect(listener).not.toHaveBeenCalled();

    sidebarTransitionActive = false;
    fakeWindow.dispatchEvent(new Event(SIDEBAR_RESIZE_SETTLED_EVENT));
    expect(listener).toHaveBeenCalledTimes(1);

    _el.delete(target);
  });

  it('overrides every Ant Design Sider width constraint during live preview', () => {
    const appCss = readFileSync(new URL('../App.css', import.meta.url), 'utf8');
    const activeResizeRule = appCss.match(
      /body\[data-sidebar-resizing='true'\][\s\S]*?\{([\s\S]*?)\}/,
    )?.[1] ?? '';

    expect(activeResizeRule).toContain('min-width: var(--gonavi-sidebar-resize-width) !important');
    expect(activeResizeRule).toContain('max-width: var(--gonavi-sidebar-resize-width) !important');
    expect(activeResizeRule).toContain('width: var(--gonavi-sidebar-resize-width) !important');
    expect(activeResizeRule).toContain('flex: 0 0 var(--gonavi-sidebar-resize-width) !important');
  });
});
