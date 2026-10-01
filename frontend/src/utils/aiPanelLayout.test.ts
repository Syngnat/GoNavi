import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AI_PANEL_WIDTH,
  MIN_AI_PANEL_WIDTH,
  MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED,
  clampAIPanelDockWidth,
  resolveAIPanelDockMaxWidth,
  resolveFullscreenAIPanelOverlayWidth,
  resolveOverlayAIPanelWidth,
  shouldOverlayAIPanel,
  shouldUseFullscreenAIPanelOverlay,
  sanitizeAIPanelWidth,
} from './aiPanelLayout';

describe('aiPanelLayout', () => {
  it('keeps the v2 AI panel docked while enough workbench width remains', () => {
    expect(shouldOverlayAIPanel({
      viewportWidth: 1440,
      sidebarWidth: 330,
      panelWidth: DEFAULT_AI_PANEL_WIDTH,
      minWorkbenchWidth: 320,
    })).toBe(false);
  });

  it('switches the v2 AI panel to overlay mode when docking would crush the workbench', () => {
    expect(shouldOverlayAIPanel({
      viewportWidth: 825,
      sidebarWidth: 330,
      panelWidth: DEFAULT_AI_PANEL_WIDTH,
      minWorkbenchWidth: 320,
    })).toBe(true);
  });

  it('uses default dimensions to keep the workbench from being crushed by the AI panel', () => {
    expect(shouldOverlayAIPanel({
      viewportWidth: 825,
      sidebarWidth: 330,
    })).toBe(true);
  });

  it('clamps overlay width to the available workspace instead of overflowing', () => {
    expect(resolveOverlayAIPanelWidth({
      viewportWidth: 825,
      sidebarWidth: 330,
      panelWidth: DEFAULT_AI_PANEL_WIDTH,
      minOverlayWidth: 260,
      overlayGap: 12,
    })).toBe(380);

    expect(resolveOverlayAIPanelWidth({
      viewportWidth: 620,
      sidebarWidth: 330,
      panelWidth: DEFAULT_AI_PANEL_WIDTH,
      minOverlayWidth: 260,
      overlayGap: 12,
    })).toBe(278);

    expect(resolveOverlayAIPanelWidth({
      viewportWidth: 540,
      sidebarWidth: 330,
      panelWidth: DEFAULT_AI_PANEL_WIDTH,
      minOverlayWidth: 260,
      overlayGap: 12,
    })).toBe(210);
  });

  it('lets the docked AI panel grow past the old 520px cap up to remaining workbench space', () => {
    expect(resolveAIPanelDockMaxWidth(1440)).toBe(1440 - MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED);
    expect(clampAIPanelDockWidth(800, 1440)).toBe(800);
    expect(clampAIPanelDockWidth(200, 1440)).toBe(MIN_AI_PANEL_WIDTH);
    expect(clampAIPanelDockWidth(2000, 1440)).toBe(1440 - MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED);
  });

  it('does not impose a pixel cap when the viewport size is unknown', () => {
    expect(resolveAIPanelDockMaxWidth(0)).toBe(Number.POSITIVE_INFINITY);
    expect(clampAIPanelDockWidth(960, 0)).toBe(960);
  });

  it('uses a viewport-wide overlay below the compact layout breakpoint', () => {
    expect(shouldUseFullscreenAIPanelOverlay(390)).toBe(true);
    expect(shouldUseFullscreenAIPanelOverlay(640)).toBe(false);
    expect(resolveFullscreenAIPanelOverlayWidth(390)).toBe(DEFAULT_AI_PANEL_WIDTH);
    expect(resolveFullscreenAIPanelOverlayWidth(320)).toBe(320);
  });
});

describe('sanitizeAIPanelWidth', () => {
  it('keeps a dragged width and floors it at the dock minimum', () => {
    expect(sanitizeAIPanelWidth(520)).toBe(520);
    expect(sanitizeAIPanelWidth(MIN_AI_PANEL_WIDTH - 40)).toBe(MIN_AI_PANEL_WIDTH);
  });

  it('falls back to the default for missing or invalid persisted values', () => {
    expect(sanitizeAIPanelWidth(undefined)).toBe(DEFAULT_AI_PANEL_WIDTH);
    expect(sanitizeAIPanelWidth(0)).toBe(DEFAULT_AI_PANEL_WIDTH);
    expect(sanitizeAIPanelWidth('wide')).toBe(DEFAULT_AI_PANEL_WIDTH);
    expect(sanitizeAIPanelWidth(-100)).toBe(DEFAULT_AI_PANEL_WIDTH);
  });
});
