export type TitleBarLayout = {
  height: number;
  actionHeight: number;
  dividerHeight: number;
  /** Height of the upper titlebar row when docked collapsed actions use a second row. */
  upperBandHeight: number;
  emptyWorkbenchTopOffset: number;
};

const MIN_UI_SCALE = 0.8;
const MAX_UI_SCALE = 1.25;
const MIN_SIDEBAR_BUTTON_SCALE = 1;
const MAX_SIDEBAR_BUTTON_SCALE = 1.8;

export type TitlebarRuntimePlatform = 'darwin' | 'windows' | null;

/**
 * Resolve the desktop platform used by titlebar behavior.
 *
 * Wails' runtime value is authoritative when present. Browser platform data is
 * only used during the short bootstrap window before the runtime reports it.
 * Keep the browser checks explicit: a broad `win` substring also matches
 * `Darwin`, which would otherwise select Windows window controls on macOS.
 */
export const resolveTitlebarRuntimePlatform = (
  runtimePlatform: string,
  navigatorPlatform: string,
): TitlebarRuntimePlatform => {
  const runtime = String(runtimePlatform || '').trim().toLowerCase();
  if (runtime !== '') {
    if (runtime === 'darwin' || runtime === 'macos' || runtime === 'mac') {
      return 'darwin';
    }
    if (runtime === 'windows' || runtime === 'win32' || runtime === 'win') {
      return 'windows';
    }
    return null;
  }

  const navigator = String(navigatorPlatform || '').trim().toLowerCase();
  const isMacNavigator = navigator === 'mac'
    || navigator.includes('macintosh')
    || navigator.includes('macintel')
    || navigator.includes('macppc')
    || navigator.includes('mac68k')
    || navigator.includes('mac os')
    || navigator.includes('macos')
    || navigator.includes('darwin');
  if (isMacNavigator) {
    return 'darwin';
  }
  const isWindowsNavigator = navigator === 'win'
    || navigator.includes('windows')
    || navigator.includes('win32')
    || navigator.includes('win64')
    || navigator.includes('winnt');
  if (isWindowsNavigator) {
    return 'windows';
  }
  return null;
};

/** Store runtime aliases in the canonical values used by document platform CSS. */
export const normalizeTitlebarRuntimePlatform = (runtimePlatform: string): string => {
  const normalized = String(runtimePlatform || '').trim().toLowerCase();
  if (normalized === 'linux') {
    return normalized;
  }
  return resolveTitlebarRuntimePlatform(normalized, '') ?? normalized;
};

/**
 * Resolve the canonical platform value used by document-level CSS selectors.
 *
 * During bootstrap the Wails environment call has not completed yet, so use
 * the browser platform as a temporary value. Once a runtime value exists it
 * remains authoritative, including for platforms that do not have a titlebar
 * layout override.
 */
export const resolveDocumentPlatform = (
  runtimePlatform: string,
  navigatorPlatform: string,
): string => {
  const runtime = String(runtimePlatform || '').trim();
  if (runtime !== '') {
    return normalizeTitlebarRuntimePlatform(runtime);
  }

  const navigator = String(navigatorPlatform || '').trim();
  if (/android/i.test(navigator)) {
    return '';
  }
  if (/linux/i.test(navigator)) {
    return 'linux';
  }
  return resolveTitlebarRuntimePlatform('', navigator) ?? '';
};

/**
 * Collapsed explorer actions use the titlebar's second row on desktop V2
 * runtimes whose window chrome has enough horizontal space for the toolbar.
 *
 * The runtime platform is authoritative when available. Browser platform
 * detection is only a fallback for the web/bootstrap phase before Wails has
 * reported its platform.
 */
export const shouldDockCollapsedSidebarActionsInTitlebar = (
  runtimePlatform: string,
  navigatorPlatform: string,
  isWebRuntime = false,
): boolean => {
  return !isWebRuntime
    && resolveTitlebarRuntimePlatform(runtimePlatform, navigatorPlatform) !== null;
};

const resolveUiScale = (uiScale: number): number => {
  const parsed = Number(uiScale);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, parsed));
};

const resolveSidebarButtonScale = (sidebarButtonScale: number): number => {
  const parsed = Number(sidebarButtonScale);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.min(MAX_SIDEBAR_BUTTON_SCALE, Math.max(MIN_SIDEBAR_BUTTON_SCALE, parsed));
};

/** Keep the V2 titlebar comfortably clickable; only reserve a second band for docked collapsed-sidebar actions. */
export const resolveTitleBarLayout = (
  uiScale: number,
  reserveCollapsedActionBand = false,
  sidebarButtonScale = 1,
): TitleBarLayout => {
  const scale = resolveUiScale(uiScale);
  const resolvedSidebarButtonScale = resolveSidebarButtonScale(sidebarButtonScale);
  const titlebarBaseHeight = 36;
  const actionBaseHeight = 30;
  const dividerBaseHeight = 14;
  const compactLayout = {
    height: Math.max(28, Math.round(titlebarBaseHeight * scale)),
    actionHeight: Math.max(24, Math.round(actionBaseHeight * scale)),
    dividerHeight: Math.max(10, Math.round(dividerBaseHeight * scale)),
    upperBandHeight: Math.max(28, Math.round(titlebarBaseHeight * scale)),
    emptyWorkbenchTopOffset: 0,
  };

  if (!reserveCollapsedActionBand) {
    return compactLayout;
  }

  // Keep the first titlebar row compact and reserve a full second row for the
  // docked collapsed-sidebar actions on desktop platforms.
  const upperBandBottom = 16 + (Math.max(26, compactLayout.actionHeight) / 2);
  const upperBandHeight = Math.ceil(upperBandBottom);
  const collapsedActionBandHeight = 26 * scale * resolvedSidebarButtonScale;
  const minimumTwoBandHeight = Math.ceil(
    upperBandHeight
    + 1 // visual separation between the rows
    + collapsedActionBandHeight
    + 1, // bottom inset used by the docked toolbar
  );

  const height = Math.max(Math.round(56 * scale), minimumTwoBandHeight);
  return {
    ...compactLayout,
    height,
    upperBandHeight,
    // The empty landing page already reserves enough room above its heading.
    // Let it overlap this extra band so collapsing the explorer does not move
    // the whole workbench down; regular tab content still starts below it.
    emptyWorkbenchTopOffset: height - compactLayout.height,
  };
};
