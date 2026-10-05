import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SIDEBAR_TREE_PANEL_FROZEN_ATTRIBUTE,
  SIDEBAR_TREE_PANEL_FROZEN_HEIGHT_VARIABLE,
  SIDEBAR_TREE_PANEL_FROZEN_WIDTH_VARIABLE,
  createSidebarTreePanelFreeze,
} from './sidebarTreePanelFreeze';
import { readV2ThemeCss } from '../test/readV2ThemeCss';
import { readCssWithImports } from '../test/readCssWithImports';

type ResizeCallback = (entries: Array<{ contentRect: { width: number; height: number } }>) => void;

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;

  constructor(readonly callback: ResizeCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: unknown) {
    this.observed.push(target);
  }

  disconnect() {
    this.disconnected = true;
  }

  report(width: number, height: number) {
    this.callback([{ contentRect: { width, height } }]);
  }
}

class FakePanel {
  private attributes = new Map<string, string>();
  private properties = new Map<string, string>();
  style = {
    setProperty: (name: string, value: string) => { this.properties.set(name, value); },
    removeProperty: (name: string) => { this.properties.delete(name); },
    getPropertyValue: (name: string) => this.properties.get(name) || '',
  };

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
}

const createSider = (panel: FakePanel) => ({
  querySelector: (selector: string) => (selector === '[data-sidebar-tree-panel="true"]' ? panel : null),
}) as unknown as Element;

describe('sidebar tree panel freeze', () => {
  const previousResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = previousResizeObserver;
  });

  it('pins the explorer to its last expanded size until released', () => {
    const panel = new FakePanel();
    const freeze = createSidebarTreePanelFreeze();
    freeze.observe(createSider(panel));
    FakeResizeObserver.instances[0].report(329, 863.90625);

    freeze.freeze();

    expect(panel.getAttribute(SIDEBAR_TREE_PANEL_FROZEN_ATTRIBUTE)).toBe('true');
    expect(panel.style.getPropertyValue(SIDEBAR_TREE_PANEL_FROZEN_WIDTH_VARIABLE)).toBe('329px');
    expect(panel.style.getPropertyValue(SIDEBAR_TREE_PANEL_FROZEN_HEIGHT_VARIABLE)).toBe('863.90625px');

    freeze.release();

    expect(panel.getAttribute(SIDEBAR_TREE_PANEL_FROZEN_ATTRIBUTE)).toBe(null);
    expect(panel.style.getPropertyValue(SIDEBAR_TREE_PANEL_FROZEN_WIDTH_VARIABLE)).toBe('');
  });

  it('ignores collapsed geometry and keeps the first frozen size across rapid toggles', () => {
    const panel = new FakePanel();
    const freeze = createSidebarTreePanelFreeze();
    freeze.observe(createSider(panel));
    const observer = FakeResizeObserver.instances[0];
    observer.report(320, 800);

    freeze.freeze();
    observer.report(0, 780);
    freeze.freeze();

    expect(panel.style.getPropertyValue(SIDEBAR_TREE_PANEL_FROZEN_WIDTH_VARIABLE)).toBe('320px');
    expect(panel.style.getPropertyValue(SIDEBAR_TREE_PANEL_FROZEN_HEIGHT_VARIABLE)).toBe('800px');
  });

  it('does not freeze before the explorer has been measured', () => {
    const panel = new FakePanel();
    const freeze = createSidebarTreePanelFreeze();
    freeze.observe(createSider(panel));

    freeze.freeze();

    expect(panel.getAttribute(SIDEBAR_TREE_PANEL_FROZEN_ATTRIBUTE)).toBe(null);
  });

  it('releases the panel and stops observing on dispose', () => {
    const panel = new FakePanel();
    const freeze = createSidebarTreePanelFreeze();
    freeze.observe(createSider(panel));
    FakeResizeObserver.instances[0].report(300, 700);
    freeze.freeze();

    freeze.dispose();

    expect(panel.getAttribute(SIDEBAR_TREE_PANEL_FROZEN_ATTRIBUTE)).toBe(null);
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  });

  it('lets the frozen size override the explorer inline flex size with non-inherited variables', () => {
    const appCss = readCssWithImports(new URL('../App.css', import.meta.url));
    const frozenRule = appCss.match(/\[data-sidebar-tree-panel-frozen='true'\]\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(frozenRule).toContain('flex: 0 0 var(--gonavi-sidebar-tree-panel-frozen-width) !important;');
    expect(frozenRule).toContain('width: var(--gonavi-sidebar-tree-panel-frozen-width) !important;');
    expect(frozenRule).toContain('height: var(--gonavi-sidebar-tree-panel-frozen-height) !important;');
    expect(appCss).toMatch(/@property --gonavi-sidebar-tree-panel-frozen-width\s*\{[^}]*inherits: false;/);
    expect(appCss).toMatch(/@property --gonavi-sidebar-tree-panel-frozen-height\s*\{[^}]*inherits: false;/);
  });

  it('hides the collapsed explorer through visibility only for the fixed rail', () => {
    const appCss = readCssWithImports(new URL('../App.css', import.meta.url));
    const hiddenRule = appCss.match(
      /\.ant-layout-sider\[data-sidebar-collapsed='true'\]([^{\s]*) \[data-sidebar-tree-panel='true'\]\s*\{([^}]*)\}/,
    );

    expect(hiddenRule?.[1]).toBe("[data-sidebar-actions-placement='fixed-rail']");
    expect(hiddenRule?.[2]).toContain('visibility: hidden;');
  });

  it('keeps visibility out of the explorer tree row transitions', () => {
    const css = readV2ThemeCss();
    const switcherRule = css.match(
      /\.gn-v2-explorer-tree-shell \.ant-tree-switcher,\s*body\[data-ui-version="v2"\] \.gn-v2-explorer-tree-shell \.ant-tree-switcher::before\s*\{([^}]*)\}/,
    )?.[1] ?? '';
    const wrapperRule = css.match(
      /\.gn-v2-explorer-tree-shell \.ant-tree-node-content-wrapper\s*\{([^}]*)\}/,
    )?.[1] ?? '';

    expect(switcherRule).toContain('transition: color 0.3s, background-color 0.3s;');
    expect(wrapperRule).toContain('transition: color 0.2s, background-color 0.2s;');
  });
});
