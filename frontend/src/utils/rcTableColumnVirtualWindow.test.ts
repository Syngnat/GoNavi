import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { resolveColumnVirtualWindow } from 'rc-table/es/VirtualTable/columnVirtualWindow';

describe('rc-table stable column virtual window', () => {
  it('retains the rendered column window across a sidebar-sized viewport change', () => {
    const initialWindow = resolveColumnVirtualWindow(null, {
      offsetX: 0,
      viewportWidth: 1100,
    });

    const collapsedSidebarWindow = resolveColumnVirtualWindow(initialWindow, {
      offsetX: 0,
      viewportWidth: 1360,
    });
    const expandedSidebarWindow = resolveColumnVirtualWindow(collapsedSidebarWindow, {
      offsetX: 0,
      viewportWidth: 1100,
    });

    expect(collapsedSidebarWindow).toBe(initialWindow);
    expect(expandedSidebarWindow).toBe(initialWindow);
  });

  it('moves the rendered column window only when scrolling reaches its retained edge', () => {
    const initialWindow = resolveColumnVirtualWindow(null, {
      offsetX: 0,
      viewportWidth: 1000,
    });
    const retainedWindow = resolveColumnVirtualWindow(initialWindow, {
      offsetX: 400,
      viewportWidth: 1000,
    });
    const shiftedWindow = resolveColumnVirtualWindow(retainedWindow, {
      offsetX: 480,
      viewportWidth: 1000,
    });

    expect(retainedWindow).toBe(initialWindow);
    expect(shiftedWindow).not.toBe(initialWindow);
    expect(shiftedWindow.start).toBeLessThanOrEqual(480);
    expect(shiftedWindow.end).toBeGreaterThanOrEqual(1480);
  });

  it('ships the stable window helper in the install-time rc-table patch', () => {
    const patch = readFileSync(
      new URL('../../patches/rc-table+7.54.0.patch', import.meta.url),
      'utf8',
    );

    expect(patch).toContain('resolveColumnVirtualWindow');
    expect(patch).toContain('DEFAULT_RETENTION_BUFFER_WIDTH = 512');
    expect(patch).toContain('columnVirtualWindowRef');
    expect(patch).toContain('columnVirtualWindow: resolveBodyLineColumnVirtualWindow(itemProps.offsetX)');
    expect(patch).toContain('React.memo(BodyLine, bodyLinePropsAreEqual)');
    expect(patch).toContain('maxFitWidth = scrollWidth && scrollWidth > 0 ? Math.max(scrollWidth, clientWidth) : clientWidth');
    expect(patch).toContain('[flattenColumns, scrollWidth, maxFitWidth]');
    expect(patch).not.toContain("['prefixCls', 'flattenColumns', 'fixColumn', 'componentWidth', 'scrollX', 'direction']");
  });
});
