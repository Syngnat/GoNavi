export const DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX = 64;
export const DATA_GRID_SELECTION_AUTO_SCROLL_MIN_STEP = 4;
export const DATA_GRID_SELECTION_AUTO_SCROLL_MAX_STEP = 48;

export const getDataGridSelectionAutoScrollStep = (
  distance: number,
  edgeThreshold = DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX,
): number => {
  if (!Number.isFinite(distance)) {
    return distance === Number.POSITIVE_INFINITY
      ? DATA_GRID_SELECTION_AUTO_SCROLL_MAX_STEP
      : 0;
  }
  if (distance <= 0) {
    return 0;
  }

  const threshold = Number.isFinite(edgeThreshold) && edgeThreshold > 0
    ? edgeThreshold
    : DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX;
  const proximity = Math.min(distance, threshold) / threshold;
  const step = DATA_GRID_SELECTION_AUTO_SCROLL_MIN_STEP
    + (DATA_GRID_SELECTION_AUTO_SCROLL_MAX_STEP - DATA_GRID_SELECTION_AUTO_SCROLL_MIN_STEP)
      * proximity ** 2;
  return Math.round(step);
};

export const clampDataGridSelectionAutoScrollDelta = (
  delta: number,
  currentScroll: number,
  maxScroll: number,
): number => {
  if (!Number.isFinite(delta) || !Number.isFinite(currentScroll) || !Number.isFinite(maxScroll)) {
    return 0;
  }

  const limit = Math.max(0, maxScroll);
  const next = Math.min(limit, Math.max(0, currentScroll + delta));
  return next - currentScroll;
};
