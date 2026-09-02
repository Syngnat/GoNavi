export const DEFAULT_AI_PANEL_WIDTH = 380;
export const MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED = 320;
export const MIN_AI_PANEL_OVERLAY_WIDTH = 260;
export const AI_PANEL_OVERLAY_GAP = 12;
export const AI_PANEL_FULLSCREEN_OVERLAY_BREAKPOINT = 640;

interface AIPanelLayoutOptions {
  isV2Ui: boolean;
  viewportWidth: number;
  sidebarWidth: number;
  panelWidth?: number;
  minWorkbenchWidth?: number;
}

interface AIPanelOverlayWidthOptions {
  viewportWidth: number;
  sidebarWidth: number;
  panelWidth?: number;
  minOverlayWidth?: number;
  overlayGap?: number;
}

const normalizePositiveNumber = (value: number, fallback: number) => {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
};

export const shouldUseFullscreenAIPanelOverlay = (viewportWidth: number): boolean => {
  const safeViewportWidth = normalizePositiveNumber(viewportWidth, 0);
  return safeViewportWidth > 0 && safeViewportWidth < AI_PANEL_FULLSCREEN_OVERLAY_BREAKPOINT;
};

export const resolveFullscreenAIPanelOverlayWidth = (
  viewportWidth: number,
  panelWidth = DEFAULT_AI_PANEL_WIDTH,
): number => {
  const safeViewportWidth = normalizePositiveNumber(viewportWidth, panelWidth);
  const safePanelWidth = Math.max(0, normalizePositiveNumber(panelWidth, DEFAULT_AI_PANEL_WIDTH));
  return Math.min(safeViewportWidth, safePanelWidth);
};

export const shouldOverlayAIPanel = ({
  isV2Ui,
  viewportWidth,
  sidebarWidth,
  panelWidth = DEFAULT_AI_PANEL_WIDTH,
  minWorkbenchWidth = MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED,
}: AIPanelLayoutOptions): boolean => {
  const safeViewportWidth = normalizePositiveNumber(viewportWidth, 0);
  const safeSidebarWidth = Math.max(0, normalizePositiveNumber(sidebarWidth, 0));
  const safePanelWidth = Math.max(0, normalizePositiveNumber(panelWidth, DEFAULT_AI_PANEL_WIDTH));
  const safeMinWorkbenchWidth = Math.max(0, normalizePositiveNumber(minWorkbenchWidth, MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED));
  const workspaceWidth = Math.max(0, safeViewportWidth - safeSidebarWidth);

  void isV2Ui;
  return workspaceWidth - safePanelWidth < safeMinWorkbenchWidth;
};

export const resolveOverlayAIPanelWidth = ({
  viewportWidth,
  sidebarWidth,
  panelWidth = DEFAULT_AI_PANEL_WIDTH,
  minOverlayWidth = MIN_AI_PANEL_OVERLAY_WIDTH,
  overlayGap = AI_PANEL_OVERLAY_GAP,
}: AIPanelOverlayWidthOptions): number => {
  const safeViewportWidth = normalizePositiveNumber(viewportWidth, panelWidth);
  const safeSidebarWidth = Math.max(0, normalizePositiveNumber(sidebarWidth, 0));
  const safePanelWidth = Math.max(0, normalizePositiveNumber(panelWidth, DEFAULT_AI_PANEL_WIDTH));
  const safeMinOverlayWidth = Math.max(0, normalizePositiveNumber(minOverlayWidth, MIN_AI_PANEL_OVERLAY_WIDTH));
  const safeOverlayGap = Math.max(0, normalizePositiveNumber(overlayGap, AI_PANEL_OVERLAY_GAP));
  const workspaceWidth = Math.max(0, safeViewportWidth - safeSidebarWidth);
  const preferredWidth = Math.min(safePanelWidth, Math.max(0, workspaceWidth - safeOverlayGap));
  const lowerBound = Math.min(safeMinOverlayWidth, workspaceWidth);

  return Math.max(lowerBound, preferredWidth);
};
