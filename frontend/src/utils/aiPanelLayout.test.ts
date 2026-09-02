import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AI_PANEL_WIDTH,
  resolveFullscreenAIPanelOverlayWidth,
  resolveOverlayAIPanelWidth,
  shouldOverlayAIPanel,
  shouldUseFullscreenAIPanelOverlay,
} from './aiPanelLayout';

describe('aiPanelLayout', () => {
  it('keeps the v2 AI panel docked while enough workbench width remains', () => {
    expect(shouldOverlayAIPanel({
      isV2Ui: true,
      viewportWidth: 1440,
      sidebarWidth: 330,
      panelWidth: DEFAULT_AI_PANEL_WIDTH,
      minWorkbenchWidth: 320,
    })).toBe(false);
  });

  it('switches the v2 AI panel to overlay mode when docking would crush the workbench', () => {
    expect(shouldOverlayAIPanel({
      isV2Ui: true,
      viewportWidth: 825,
      sidebarWidth: 330,
      panelWidth: DEFAULT_AI_PANEL_WIDTH,
      minWorkbenchWidth: 320,
    })).toBe(true);
  });

  it('also protects the legacy UI from being crushed by the AI panel', () => {
    expect(shouldOverlayAIPanel({
      isV2Ui: false,
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

  it('uses a viewport-wide overlay below the compact layout breakpoint', () => {
    expect(shouldUseFullscreenAIPanelOverlay(390)).toBe(true);
    expect(shouldUseFullscreenAIPanelOverlay(640)).toBe(false);
    expect(resolveFullscreenAIPanelOverlayWidth(390)).toBe(DEFAULT_AI_PANEL_WIDTH);
    expect(resolveFullscreenAIPanelOverlayWidth(320)).toBe(320);
  });
});
