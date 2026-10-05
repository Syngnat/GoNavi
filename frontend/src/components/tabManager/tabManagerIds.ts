export const buildWorkbenchQueryTabId = (): string =>
  `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
