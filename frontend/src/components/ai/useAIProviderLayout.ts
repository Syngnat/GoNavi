import React from 'react';

const STORAGE_KEY = 'gonavi.ai.providers.layout.v1';
const DEFAULT_WIDTH = 336;
// Two-column geometry. One compact catalog column is 112px plus padding, so the
// floor is 128px; the catalog may never squeeze the editor below MIN_EDITOR_WIDTH,
// and the drawer breakpoint is derived from that same budget instead of a standalone
// guess, so a workspace that can still seat both columns never falls into drawer mode.
export const MIN_CATALOG_WIDTH = 128;
export const MAX_CATALOG_WIDTH = 520;
export const MIN_EDITOR_WIDTH = 200;
// Keep in sync with `.gonavi-ai-provider-resizer { flex: 0 0 17px }`.
export const RESIZER_WIDTH = 17;
export const MIN_HIDDEN_PANE_HEIGHT = 72;
export const MAX_HIDDEN_PANE_RATIO = 2 / 3;
export const NARROW_BREAKPOINT = MIN_CATALOG_WIDTH + RESIZER_WIDTH + MIN_EDITOR_WIDTH;
export const isNarrowWorkspace = (width: number) => width > 0 && width < NARROW_BREAKPOINT;
export const maxCatalogWidth = (width: number) => Math.max(MIN_CATALOG_WIDTH,
  Math.min(MAX_CATALOG_WIDTH, width ? width - MIN_EDITOR_WIDTH - RESIZER_WIDTH : MAX_CATALOG_WIDTH));
export const maxHiddenPaneHeight = (catalogHeight: number) => Math.max(MIN_HIDDEN_PANE_HEIGHT,
  Math.floor((catalogHeight > 0 ? catalogHeight : MIN_HIDDEN_PANE_HEIGHT) * MAX_HIDDEN_PANE_RATIO));
export const clampHiddenPaneHeight = (height: number, catalogHeight: number) =>
  Math.min(maxHiddenPaneHeight(catalogHeight), Math.max(MIN_HIDDEN_PANE_HEIGHT, height));
export const snapHiddenPaneHeight = (height: number | null, catalogHeight: number) => {
  if (height == null || height <= MIN_HIDDEN_PANE_HEIGHT) return null;
  return clampHiddenPaneHeight(height, catalogHeight);
};
export const workspaceClassName = (narrow: boolean, catalogVisible: boolean, dragging: boolean) =>
  `gonavi-ai-provider-workspace${narrow ? ' is-narrow' : ''}${narrow && catalogVisible ? ' is-drawer-open' : ''}${dragging ? ' is-resizing' : ''}`;
interface LayoutPreferences {
  catalogCollapsed: boolean;
  catalogWidth: number;
  savedCollapsed: boolean;
  density: 'compact' | 'normal';
  hiddenPresetKeys: string[];
  hiddenPaneHeight: number | null;
}
const defaults: LayoutPreferences = { catalogCollapsed: false, catalogWidth: DEFAULT_WIDTH, savedCollapsed: false, density: 'compact', hiddenPresetKeys: [], hiddenPaneHeight: null };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const scheduleFrame = (frame: { current: number }, paint: () => void) => {
  if (frame.current) return;
  if (typeof requestAnimationFrame !== 'function') { paint(); return; }
  frame.current = requestAnimationFrame(() => { frame.current = 0; paint(); });
};

function readPreferences(): LayoutPreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return { catalogCollapsed: value.catalogCollapsed === true, savedCollapsed: value.savedCollapsed === true,
      density: value.density === 'normal' ? 'normal' : 'compact',
      hiddenPresetKeys: Array.isArray(value.hiddenPresetKeys)
        ? [...new Set<string>(value.hiddenPresetKeys.filter((key: unknown): key is string => typeof key === 'string' && Boolean(key.trim())).map((key: string) => key.trim()))] : [],
      catalogWidth: Number.isFinite(value.catalogWidth) ? clamp(value.catalogWidth, MIN_CATALOG_WIDTH, MAX_CATALOG_WIDTH) : DEFAULT_WIDTH,
      hiddenPaneHeight: Number.isFinite(value.hiddenPaneHeight) && value.hiddenPaneHeight > 0 ? value.hiddenPaneHeight : null };
  } catch { return { ...defaults }; }
}

// Persist layout preferences only. Provider drafts, credentials and model state
// continue through the existing application configuration service.
export function useAIProviderLayout() {
  const [preferences, setPreferences] = React.useState(readPreferences);
  const [width, setWidth] = React.useState(0);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [catalogHeight, setCatalogHeight] = React.useState(0);
  const workspaceRef = React.useRef<HTMLDivElement>(null);
  const catalogRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ x: number; width: number; preference: number } | null>(null);
  const splitDrag = React.useRef<{ y: number; height: number; preference: number | null } | null>(null);
  const widthFrame = React.useRef(0);
  const splitFrame = React.useRef(0);
  const narrow = isNarrowWorkspace(width);
  const maximum = maxCatalogWidth(width);
  const catalogWidth = clamp(preferences.catalogWidth, MIN_CATALOG_WIDTH, maximum);
  const hiddenPaneHeight = preferences.hiddenPaneHeight == null ? null
    : clampHiddenPaneHeight(preferences.hiddenPaneHeight, catalogHeight);
  const liveWidth = React.useRef(catalogWidth);
  const liveHidden = React.useRef(hiddenPaneHeight);
  React.useEffect(() => {
    if (dragging) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Private storage may be unavailable. */ }
  }, [preferences, dragging]);
  React.useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(workspace.getBoundingClientRect().width));
    setWidth(workspace.getBoundingClientRect().width);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    const catalog = catalogRef.current;
    if (!catalog || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (drag.current || splitDrag.current) return;
      setCatalogHeight(catalog.getBoundingClientRect().height);
    });
    setCatalogHeight(catalog.getBoundingClientRect().height);
    observer.observe(catalog);
    return () => observer.disconnect();
  }, [narrow, preferences.catalogCollapsed]);
  React.useEffect(() => { setDrawerOpen(false); drag.current = null; splitDrag.current = null; setDragging(false); }, [narrow]);
  const setPreference = <K extends keyof LayoutPreferences>(key: K, value: LayoutPreferences[K]) =>
    setPreferences((previous) => ({ ...previous, [key]: value }));
  const setPresetHidden = (key: string, hidden: boolean) => setPreferences((previous) => ({
    ...previous,
    hiddenPresetKeys: hidden ? [...new Set([...previous.hiddenPresetKeys, key])]
      : previous.hiddenPresetKeys.filter((presetKey) => presetKey !== key),
  }));
  const paintCatalogWidth = (next: number) => {
    liveWidth.current = next;
    const catalog = catalogRef.current;
    const shell = workspaceRef.current?.parentElement;
    if (catalog) { catalog.style.width = `${next}px`; catalog.style.flexBasis = `${next}px`; }
    shell?.style.setProperty('--provider-catalog-width', `${next}px`);
  };
  const finishDrag = (cancel: boolean) => {
    if (widthFrame.current) { cancelAnimationFrame(widthFrame.current); widthFrame.current = 0; }
    if (drag.current) {
      const next = cancel ? drag.current.preference : liveWidth.current;
      paintCatalogWidth(next);
      setPreference('catalogWidth', next);
    }
    drag.current = null; setDragging(false);
  };
  const paintHiddenHeight = (next: number | null) => {
    liveHidden.current = next;
    const catalog = catalogRef.current;
    if (!catalog) return;
    catalog.classList.toggle('is-hidden-pinned', next != null);
    if (next == null) catalog.style.removeProperty('--provider-hidden-pane');
    else catalog.style.setProperty('--provider-hidden-pane', `${next}px`);
  };
  const finishSplitDrag = (cancel: boolean) => {
    if (splitFrame.current) { cancelAnimationFrame(splitFrame.current); splitFrame.current = 0; }
    if (splitDrag.current) {
      const next = cancel ? splitDrag.current.preference : snapHiddenPaneHeight(liveHidden.current, catalogHeight);
      paintHiddenHeight(next);
      setPreference('hiddenPaneHeight', next);
    }
    splitDrag.current = null; setDragging(false);
  };
  const hiddenMax = maxHiddenPaneHeight(catalogHeight);
  const hiddenSplitProps = {
    role: 'separator', tabIndex: 0, 'aria-orientation': 'horizontal' as const,
    'aria-valuemin': MIN_HIDDEN_PANE_HEIGHT, 'aria-valuemax': hiddenMax,
    'aria-valuenow': Math.round(hiddenPaneHeight || MIN_HIDDEN_PANE_HEIGHT),
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      const start = hiddenPaneHeight ?? Math.round(catalogRef.current?.querySelector('.gonavi-ai-provider-catalog-footer')?.getBoundingClientRect().height || MIN_HIDDEN_PANE_HEIGHT);
      liveHidden.current = start;
      splitDrag.current = { y: event.clientY, height: start, preference: preferences.hiddenPaneHeight }; setDragging(true);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!splitDrag.current) return;
      const raw = splitDrag.current.height - (event.clientY - splitDrag.current.y);
      liveHidden.current = snapHiddenPaneHeight(raw, catalogHeight);
      scheduleFrame(splitFrame, () => paintHiddenHeight(liveHidden.current));
    },
    onPointerUp: () => finishSplitDrag(false),
    onPointerCancel: () => finishSplitDrag(true),
    onLostPointerCapture: () => finishSplitDrag(false),
    onDoubleClick: () => setPreference('hiddenPaneHeight', null),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && splitDrag.current) { event.preventDefault(); event.stopPropagation(); finishSplitDrag(true); return; }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Enter' || event.key === 'Home') { setPreference('hiddenPaneHeight', null); return; }
      const current = hiddenPaneHeight ?? MIN_HIDDEN_PANE_HEIGHT;
      const next = event.key === 'End' ? hiddenMax : current + (event.key === 'ArrowUp' ? 16 : -16);
      setPreference('hiddenPaneHeight', snapHiddenPaneHeight(next, catalogHeight));
    },
  };
  const resizerProps = {
    role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical' as const,
    'aria-valuemin': MIN_CATALOG_WIDTH, 'aria-valuemax': maximum, 'aria-valuenow': Math.round(catalogWidth),
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || narrow) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      liveWidth.current = catalogWidth;
      drag.current = { x: event.clientX, width: catalogWidth, preference: preferences.catalogWidth }; setDragging(true);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      liveWidth.current = clamp(drag.current.width + event.clientX - drag.current.x, MIN_CATALOG_WIDTH, maximum);
      scheduleFrame(widthFrame, () => paintCatalogWidth(liveWidth.current));
    },
    onPointerUp: () => finishDrag(false),
    onPointerCancel: () => finishDrag(true),
    onLostPointerCapture: () => finishDrag(false),
    onDoubleClick: () => setPreference('catalogWidth', DEFAULT_WIDTH),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finishDrag(true); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? MIN_CATALOG_WIDTH : event.key === 'End' ? maximum : event.key === 'Enter' ? DEFAULT_WIDTH
        : catalogWidth + (event.key === 'ArrowRight' ? 16 : -16);
      setPreference('catalogWidth', clamp(next, MIN_CATALOG_WIDTH, maximum));
    },
  };
  return { preferences, setPreference, setPresetHidden, workspaceRef, catalogRef, catalogWidth, hiddenPaneHeight, narrow, dragging,
    resizerProps, hiddenSplitProps,
    catalogVisible: narrow ? drawerOpen : !preferences.catalogCollapsed,
    toggleCatalog: () => narrow ? setDrawerOpen((open) => !open) : setPreference('catalogCollapsed', !preferences.catalogCollapsed),
    closeDrawer: () => setDrawerOpen(false) };
}
