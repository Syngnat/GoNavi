export const DEFAULT_AI_PANEL_WIDTH = 380;
export const MIN_AI_PANEL_WIDTH = 300;
export const MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED = 320;
export const MIN_AI_PANEL_OVERLAY_WIDTH = 260;
export const AI_PANEL_OVERLAY_GAP = 12;
export const AI_PANEL_FULLSCREEN_OVERLAY_BREAKPOINT = 640;

interface AIPanelLayoutOptions {
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

export const resolveAIPanelDockMaxWidth = (
  viewportWidth: number,
  minWidth = MIN_AI_PANEL_WIDTH,
  minWorkbenchWidth = MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED,
): number => {
  const safeMinWidth = Math.max(0, normalizePositiveNumber(minWidth, MIN_AI_PANEL_WIDTH));
  const safeMinWorkbenchWidth = Math.max(
    0,
    normalizePositiveNumber(minWorkbenchWidth, MIN_WORKBENCH_WIDTH_WHEN_AI_DOCKED),
  );
  const safeViewportWidth = normalizePositiveNumber(viewportWidth, 0);
  if (safeViewportWidth <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(safeMinWidth, Math.trunc(safeViewportWidth) - safeMinWorkbenchWidth);
};

export const clampAIPanelDockWidth = (
  width: number,
  viewportWidth: number,
  minWidth = MIN_AI_PANEL_WIDTH,
): number => {
  const safeMinWidth = Math.max(0, normalizePositiveNumber(minWidth, MIN_AI_PANEL_WIDTH));
  const parsedWidth = Number(width);
  const safeWidth = Number.isFinite(parsedWidth) ? parsedWidth : DEFAULT_AI_PANEL_WIDTH;
  return Math.min(
    Math.max(safeWidth, safeMinWidth),
    resolveAIPanelDockMaxWidth(viewportWidth, safeMinWidth),
  );
};

/**
 * 持久化的面板宽度：落在停靠允许区间内。非法值（旧配置缺失、被手改成字符串）回默认值，
 * 不带着无效宽度启动 —— 窗口变窄后旧宽度会由 clampAIPanelDockWidth 在渲染时再收一次。
 */
export const sanitizeAIPanelWidth = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AI_PANEL_WIDTH;
  }
  return Math.max(MIN_AI_PANEL_WIDTH, Math.trunc(parsed));
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
