import { APP_DETACHED_WINDOW_Z_INDEX_BASE } from './overlayZIndex';

export type DetachedWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

export type DetachedWorkbenchWindow = DetachedWindowBounds & {
  tabId: string;
};

export type DetachedQueryResultSnapshot = {
  key: string;
  sql: string;
  exportSql?: string;
  sourceStatementIndex?: number;
  statementResultIndex?: number;
  rows: any[];
  columns: string[];
  messages?: string[];
  resultType?: 'grid' | 'message';
  tableName?: string;
  /** 列类型/注释元数据所属库（跨库 SELECT 时可能与窗口 dbName 不同） */
  metadataDbName?: string;
  metadataTableName?: string;
  ddlDbName?: string;
  ddlTableName?: string;
  pkColumns: string[];
  editLocator?: {
    strategy?: string;
    columns?: string[];
    values?: Record<string, unknown>;
  };
  readOnly: boolean;
  showRowNumberColumn?: boolean;
  truncated?: boolean;
  pinned?: boolean;
};

export type DetachedQueryResultWindow = DetachedWindowBounds & {
  id: string;
  sourceQueryTabId: string;
  connectionId: string;
  dbName?: string;
  title: string;
  result: DetachedQueryResultSnapshot;
};

export type DetachedWindowCoordinateSpace = 'viewport' | 'screen';

/** AI 聊天独立浮动窗（单例，会话态；尺寸/位置记忆另存） */
export type DetachedAIChatWindow = DetachedWindowBounds & {
  coordinateSpace?: DetachedWindowCoordinateSpace;
};

/** 独立窗上次尺寸与位置（持久化，再次打开时复用） */
export type AIChatDetachedBoundsMemory = Pick<
  DetachedWindowBounds,
  'x' | 'y' | 'width' | 'height'
> & { coordinateSpace?: DetachedWindowCoordinateSpace };

export const toAIChatDetachedBoundsMemory = (
  bounds: Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'> & {
    coordinateSpace?: DetachedWindowCoordinateSpace;
  },
): AIChatDetachedBoundsMemory => ({
  x: bounds.x,
  y: bounds.y,
  width: bounds.width,
  height: bounds.height,
  ...(bounds.coordinateSpace ? { coordinateSpace: bounds.coordinateSpace } : {}),
});

export const DETACH_TAB_DRAG_Y_THRESHOLD = 56;
export const DEFAULT_DETACHED_WINDOW_WIDTH = 960;
export const DEFAULT_DETACHED_WINDOW_HEIGHT = 640;
export const DEFAULT_DETACHED_WINDOW_MIN_WIDTH = 480;
export const DEFAULT_DETACHED_WINDOW_MIN_HEIGHT = 320;
export const DEFAULT_DETACHED_AI_CHAT_WIDTH = 440;
export const DEFAULT_DETACHED_AI_CHAT_HEIGHT = 720;
export const DEFAULT_DETACHED_AI_CHAT_MIN_WIDTH = 360;
export const DEFAULT_DETACHED_AI_CHAT_MIN_HEIGHT = 420;
export const DETACHED_WINDOW_VIEWPORT_PADDING = 16;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const nextDetachedZIndex = (windows: Array<{ zIndex?: number }>): number => {
  let max = APP_DETACHED_WINDOW_Z_INDEX_BASE;
  for (const windowState of windows) {
    const z = Number(windowState?.zIndex);
    if (Number.isFinite(z) && z > max) {
      max = z;
    }
  }
  return max + 1;
};

const getViewportSize = () => {
  if (typeof window === 'undefined') {
    return {
      width: DEFAULT_DETACHED_WINDOW_WIDTH + DETACHED_WINDOW_VIEWPORT_PADDING * 2,
      height: DEFAULT_DETACHED_WINDOW_HEIGHT + DETACHED_WINDOW_VIEWPORT_PADDING * 2,
    };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
};

export const createDefaultDetachedBounds = (
  windows: Array<{ zIndex?: number }>,
  preferred?: Partial<Pick<DetachedWindowBounds, 'x' | 'y' | 'width' | 'height'>>,
  sizePreset: 'workbench' | 'ai-chat' = 'workbench',
): DetachedWindowBounds => {
  const viewport = getViewportSize();
  const defaultWidth = sizePreset === 'ai-chat' ? DEFAULT_DETACHED_AI_CHAT_WIDTH : DEFAULT_DETACHED_WINDOW_WIDTH;
  const defaultHeight = sizePreset === 'ai-chat' ? DEFAULT_DETACHED_AI_CHAT_HEIGHT : DEFAULT_DETACHED_WINDOW_HEIGHT;
  const minWidth = sizePreset === 'ai-chat' ? DEFAULT_DETACHED_AI_CHAT_MIN_WIDTH : DEFAULT_DETACHED_WINDOW_MIN_WIDTH;
  const minHeight = sizePreset === 'ai-chat' ? DEFAULT_DETACHED_AI_CHAT_MIN_HEIGHT : DEFAULT_DETACHED_WINDOW_MIN_HEIGHT;
  const width = clamp(
    Number(preferred?.width) || defaultWidth,
    minWidth,
    Math.max(minWidth, viewport.width - DETACHED_WINDOW_VIEWPORT_PADDING * 2),
  );
  const height = clamp(
    Number(preferred?.height) || defaultHeight,
    minHeight,
    Math.max(minHeight, viewport.height - DETACHED_WINDOW_VIEWPORT_PADDING * 2),
  );
  const cascade = (windows.length % 8) * 28;
  const defaultX = Math.max(
    DETACHED_WINDOW_VIEWPORT_PADDING,
    Math.round((viewport.width - width) / 2) + cascade,
  );
  const defaultY = Math.max(
    DETACHED_WINDOW_VIEWPORT_PADDING,
    Math.round((viewport.height - height) / 2) + cascade,
  );
  const maxX = Math.max(DETACHED_WINDOW_VIEWPORT_PADDING, viewport.width - width - DETACHED_WINDOW_VIEWPORT_PADDING);
  const maxY = Math.max(DETACHED_WINDOW_VIEWPORT_PADDING, viewport.height - height - DETACHED_WINDOW_VIEWPORT_PADDING);
  return {
    x: clamp(Number.isFinite(Number(preferred?.x)) ? Number(preferred?.x) : defaultX, DETACHED_WINDOW_VIEWPORT_PADDING, maxX),
    y: clamp(Number.isFinite(Number(preferred?.y)) ? Number(preferred?.y) : defaultY, DETACHED_WINDOW_VIEWPORT_PADDING, maxY),
    width,
    height,
    zIndex: nextDetachedZIndex(windows),
  };
};

export const shouldDetachTabByDrag = (deltaY: number, overId?: string | null): boolean => {
  if (!Number.isFinite(deltaY)) return false;
  // 垂直拖出超过阈值即判定为独立窗口；即使仍 hover 在其他 tab 上也可拆出
  return Math.abs(deltaY) >= DETACH_TAB_DRAG_Y_THRESHOLD;
};

/** 从指针位置推算浮动窗落点，便于结果 Tab 拖出时「跟手」打开 */
export const resolveResultDetachPreferredBounds = (
  clientX: number,
  clientY: number,
): Partial<Pick<DetachedWindowBounds, 'x' | 'y'>> => ({
  x: Math.max(DETACHED_WINDOW_VIEWPORT_PADDING, Math.round(clientX - 120)),
  y: Math.max(DETACHED_WINDOW_VIEWPORT_PADDING, Math.round(clientY - 24)),
});

export const resolveNativeDetachReleasePoint = (input: {
  startScreenX: number;
  startScreenY: number;
  deltaX: number;
  deltaY: number;
}): { screenX: number; screenY: number } => ({
  screenX: Math.round(Number(input.startScreenX) + Number(input.deltaX)),
  screenY: Math.round(Number(input.startScreenY) + Number(input.deltaY)),
});

export type NativeDetachTerminalPointer = {
  type: 'pointerup' | 'pointercancel';
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
};

export const resolveNativeDetachDragRelease = (input: {
  startClientX: number;
  startClientY: number;
  startScreenX: number;
  startScreenY: number;
  fallbackDeltaX: number;
  fallbackDeltaY: number;
  terminalPointer?: NativeDetachTerminalPointer | null;
}): {
  deltaX: number;
  deltaY: number;
  screenX: number;
  screenY: number;
  terminalType?: NativeDetachTerminalPointer['type'];
} => {
  const terminal = input.terminalPointer;
  const hasTerminalClientPoint = Boolean(terminal)
    && Number.isFinite(Number(terminal?.clientX))
    && Number.isFinite(Number(terminal?.clientY));
  const deltaX = hasTerminalClientPoint
    ? Number(terminal?.clientX) - Number(input.startClientX)
    : Number(input.fallbackDeltaX);
  const deltaY = hasTerminalClientPoint
    ? Number(terminal?.clientY) - Number(input.startClientY)
    : Number(input.fallbackDeltaY);
  const hasTerminalScreenPoint = Boolean(terminal)
    && Number.isFinite(Number(terminal?.screenX))
    && Number.isFinite(Number(terminal?.screenY));
  const fallbackRelease = resolveNativeDetachReleasePoint({
    startScreenX: input.startScreenX,
    startScreenY: input.startScreenY,
    deltaX,
    deltaY,
  });
  return {
    deltaX,
    deltaY,
    screenX: hasTerminalScreenPoint ? Math.round(Number(terminal?.screenX)) : fallbackRelease.screenX,
    screenY: hasTerminalScreenPoint ? Math.round(Number(terminal?.screenY)) : fallbackRelease.screenY,
    ...(terminal ? { terminalType: terminal.type } : {}),
  };
};

/** Native windows use virtual-desktop coordinates, which may be negative. */
export const resolveNativeDetachPreferredBounds = (
  screenX: number,
  screenY: number,
): Partial<Pick<DetachedWindowBounds, 'x' | 'y'>> => ({
  x: Math.round(Number(screenX) - 120),
  y: Math.round(Number(screenY) - 24),
});

export const shouldDetachAtScreenPoint = (
  screenX: number,
  screenY: number,
  hostBounds: { x: number; y: number; width: number; height: number },
): boolean => {
  const x = Number(screenX);
  const y = Number(screenY);
  const left = Number(hostBounds.x);
  const top = Number(hostBounds.y);
  const width = Number(hostBounds.width);
  const height = Number(hostBounds.height);
  if (![x, y, left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return false;
  }
  return x < left || x > left + width || y < top || y > top + height;
};

export const shouldDetachAfterNativePointerCancel = (
  release: {
    terminalType?: NativeDetachTerminalPointer['type'];
    deltaY: number;
    screenX: number;
    screenY: number;
  },
  hostBounds: { x: number; y: number; width: number; height: number },
): boolean => release.terminalType === 'pointercancel'
  && (
    shouldDetachTabByDrag(release.deltaY)
    || shouldDetachAtScreenPoint(release.screenX, release.screenY, hostBounds)
  );

export const resolveDetachedWindowTitle = (params: {
  kindLabel: string;
  objectLabel?: string;
  fallbackTitle: string;
}): string => {
  const objectLabel = String(params.objectLabel || '').trim();
  if (objectLabel) {
    return `${params.kindLabel} · ${objectLabel}`;
  }
  return String(params.fallbackTitle || params.kindLabel || '').trim() || params.kindLabel;
};
