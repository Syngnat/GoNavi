import { describe, expect, it } from 'vitest';
import {
  isNarrowWorkspace, maxCatalogWidth, snapHiddenPaneHeight, workspaceClassName,
  MAX_CATALOG_WIDTH, MIN_CATALOG_WIDTH, MIN_EDITOR_WIDTH, MIN_HIDDEN_PANE_HEIGHT,
  NARROW_BREAKPOINT, RESIZER_WIDTH,
} from './useAIProviderLayout';

// Regression: the settings centre workspace measured 633px on a 1440x900 desktop.
// The former 660px breakpoint pushed that width into drawer mode, so the catalog
// floated over the workspace and the scrim was left exposed as a bare grey slab.
const OBSERVED_DESKTOP_WORKSPACE = 633;

describe('provider workspace geometry', () => {
  it('derives the drawer breakpoint from the two-column budget', () => {
    expect(NARROW_BREAKPOINT).toBe(MIN_CATALOG_WIDTH + RESIZER_WIDTH + MIN_EDITOR_WIDTH);
    expect(MIN_CATALOG_WIDTH).toBe(128);
    expect(MIN_EDITOR_WIDTH).toBe(200);
    expect(NARROW_BREAKPOINT).toBe(345);
  });

  it('keeps the observed desktop workspace in two-column mode', () => {
    expect(isNarrowWorkspace(OBSERVED_DESKTOP_WORKSPACE)).toBe(false);
    const editorWidth = OBSERVED_DESKTOP_WORKSPACE - maxCatalogWidth(OBSERVED_DESKTOP_WORKSPACE) - RESIZER_WIDTH;
    expect(editorWidth).toBeGreaterThanOrEqual(MIN_EDITOR_WIDTH);
  });

  it('switches to the drawer only below the breakpoint', () => {
    expect(isNarrowWorkspace(NARROW_BREAKPOINT - 1)).toBe(true);
    expect(isNarrowWorkspace(NARROW_BREAKPOINT)).toBe(false);
  });

  it('treats an unmeasured workspace as wide so the drawer never flashes on mount', () => {
    expect(isNarrowWorkspace(0)).toBe(false);
    expect(maxCatalogWidth(0)).toBe(MAX_CATALOG_WIDTH);
  });

  it('unpins the hidden pane when it is dragged to the floor so the collapsed bar can dock', () => {
    expect(snapHiddenPaneHeight(null, 400)).toBeNull();
    expect(snapHiddenPaneHeight(MIN_HIDDEN_PANE_HEIGHT, 400)).toBeNull();
    expect(snapHiddenPaneHeight(MIN_HIDDEN_PANE_HEIGHT - 8, 400)).toBeNull();
    expect(snapHiddenPaneHeight(120, 400)).toBe(120);
  });

  it('never lets the catalog squeeze the editor below its minimum', () => {
    for (let width = NARROW_BREAKPOINT; width <= 1600; width += 1) {
      const catalog = maxCatalogWidth(width);
      expect(catalog).toBeGreaterThanOrEqual(MIN_CATALOG_WIDTH);
      expect(catalog).toBeLessThanOrEqual(MAX_CATALOG_WIDTH);
      expect(width - catalog - RESIZER_WIDTH).toBeGreaterThanOrEqual(MIN_EDITOR_WIDTH);
    }
  });

});

describe('workspace class name', () => {
  it('marks the drawer as open only when the catalog overlays a narrow workspace', () => {
    expect(workspaceClassName(true, true, false).split(' ')).toContain('is-drawer-open');
    expect(workspaceClassName(true, false, false).split(' ')).not.toContain('is-drawer-open');
    expect(workspaceClassName(false, true, false).split(' ')).not.toContain('is-drawer-open');
  });

  it('does not mark a two-column workspace as narrow', () => {
    const classes = workspaceClassName(isNarrowWorkspace(OBSERVED_DESKTOP_WORKSPACE), true, false).split(' ');
    expect(classes).toContain('gonavi-ai-provider-workspace');
    expect(classes).not.toContain('is-narrow');
    expect(classes).not.toContain('is-drawer-open');
  });

  it('still reports an active drag', () => {
    expect(workspaceClassName(false, true, true).split(' ')).toContain('is-resizing');
  });
});
