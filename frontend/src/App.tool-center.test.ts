import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appSource = readFileSync(
  fileURLToPath(new globalThis.URL('./App.tsx', import.meta.url)),
  'utf8',
);
const appCss = readFileSync(
  fileURLToPath(new globalThis.URL('./App.css', import.meta.url)),
  'utf8',
);
const sidebarSource = readFileSync(
  fileURLToPath(new globalThis.URL('./components/Sidebar.tsx', import.meta.url)),
  'utf8',
);

describe('settings center tool entries', () => {

  it('keeps the connection/database/object summary in the V2 explorer actions without the Host address', () => {
    const titlebarStart = appSource.indexOf('{/* Custom Title Bar */}');
    const titlebarEnd = appSource.indexOf('{showLinuxCJKFontBanner && (', titlebarStart);
    const titlebarSource = appSource.slice(titlebarStart, titlebarEnd);

    expect(titlebarStart).toBeGreaterThanOrEqual(0);
    expect(titlebarEnd).toBeGreaterThan(titlebarStart);
    expect(titlebarSource).not.toContain('className="gn-v2-titlebar-center"');
    expect(titlebarSource).not.toContain('data-titlebar-active-context');
    expect(appSource).toContain('const v2ExplorerContext = useMemo(() => ({');
    expect(appSource).toContain('v2ExplorerContext={v2ExplorerContext}');
    expect(sidebarSource).toContain('className="gn-v2-explorer-context"');
    expect(sidebarSource).toContain('{context.databaseName}');
    expect(sidebarSource).toContain('{context.objectName}');
    expect(appSource).toContain('onTitlebarSnapshotChange={setSidebarTitlebarSnapshot}');

    const explorerContextStart = appSource.indexOf('const explorerContextConnectionName');
    const explorerContextEnd = appSource.indexOf('const primaryActionIsMessageQueue', explorerContextStart);
    const explorerContextSource = appSource.slice(explorerContextStart, explorerContextEnd);
    expect(explorerContextStart).toBeGreaterThanOrEqual(0);
    expect(explorerContextEnd).toBeGreaterThan(explorerContextStart);
    expect(explorerContextSource).toContain('databaseName: titlebarContext.databaseName');
    expect(explorerContextSource).toContain('objectName: titlebarContext.tableName');
    expect(explorerContextSource).not.toContain('titlebarContext.hostSummary');
    expect(explorerContextSource).not.toContain('detailText');
  });

  it('applies the V2 document scope before the first titlebar paint', () => {
    const appearanceEffectStart = appSource.indexOf('// Apply the document theme before the first paint.');
    const appearanceEffectEnd = appSource.indexOf('  }, [', appearanceEffectStart);

    expect(appearanceEffectStart).toBeGreaterThanOrEqual(0);
    expect(appearanceEffectEnd).toBeGreaterThan(appearanceEffectStart);

    const appearanceEffectSource = appSource.slice(appearanceEffectStart, appearanceEffectEnd);
    expect(appearanceEffectSource).toContain('useLayoutEffect(() => {');
    expect(appearanceEffectSource).toContain("document.body.setAttribute('data-ui-version', appearance.uiVersion);");
  });

  it('exposes toolbar button overrides from both V2 and legacy theme settings', () => {
    expect(appSource.match(/<ToolbarButtonAppearanceSettings \/>/g)).toHaveLength(2);

    const legacySettingsStart = appSource.indexOf('const renderThemeSettingsContentLegacy = () =>');
    const legacySettingsEnd = appSource.indexOf(
      'const renderThemeSettingsContent = () =>',
      legacySettingsStart,
    );
    const legacySettingsSource = appSource.slice(legacySettingsStart, legacySettingsEnd);

    expect(legacySettingsStart).toBeGreaterThanOrEqual(0);
    expect(legacySettingsEnd).toBeGreaterThan(legacySettingsStart);
    expect(legacySettingsSource).toContain("t('app.theme.toolbar_buttons.legacy_hint')");
    expect(legacySettingsSource).toContain('<ToolbarButtonAppearanceSettings />');
  });

  it('captures native window bounds before maximising and before the final quit flush', () => {
    const startupRestoreStart = appSource.indexOf('const restoreWindowState = async');
    const startupRestoreEnd = appSource.indexOf('if (useStore.persist.hasHydrated())', startupRestoreStart);
    const startupRestoreSource = appSource.slice(startupRestoreStart, startupRestoreEnd);
    const restoreNormalBoundsBeforeMaximise = startupRestoreSource.indexOf('applyRestoredWindowBounds(bounds);');
    const startupMaximiseCall = startupRestoreSource.indexOf('applyStartupWindowChrome(1);');

    expect(startupRestoreStart).toBeGreaterThanOrEqual(0);
    expect(startupRestoreEnd).toBeGreaterThan(startupRestoreStart);
    expect(restoreNormalBoundsBeforeMaximise).toBeGreaterThanOrEqual(0);
    expect(startupMaximiseCall).toBeGreaterThan(restoreNormalBoundsBeforeMaximise);

    const titleBarToggleStart = appSource.indexOf('const handleTitleBarWindowToggle = async');
    const titleBarToggleEnd = appSource.indexOf('const handleTitleBarDoubleClick =', titleBarToggleStart);
    const titleBarToggleSource = appSource.slice(titleBarToggleStart, titleBarToggleEnd);
    const captureBeforeMaximise = titleBarToggleSource.indexOf('await captureMainWindowStateRef.current();');
    const maximiseCall = titleBarToggleSource.indexOf('WindowMaximise();', captureBeforeMaximise);

    expect(titleBarToggleStart).toBeGreaterThanOrEqual(0);
    expect(titleBarToggleEnd).toBeGreaterThan(titleBarToggleStart);
    expect(captureBeforeMaximise).toBeGreaterThanOrEqual(0);
    expect(maximiseCall).toBeGreaterThan(captureBeforeMaximise);

    const confirmedActionStart = appSource.indexOf('const runConfirmedAction = async');
    const confirmedActionEnd = appSource.indexOf('if (confirmedAction)', confirmedActionStart);
    const confirmedActionSource = appSource.slice(confirmedActionStart, confirmedActionEnd);
    const captureOnQuit = confirmedActionSource.indexOf('captureWindowState:');
    const flushOnQuit = confirmedActionSource.indexOf('flushAppState:');

    expect(confirmedActionStart).toBeGreaterThanOrEqual(0);
    expect(confirmedActionEnd).toBeGreaterThan(confirmedActionStart);
    expect(captureOnQuit).toBeGreaterThanOrEqual(0);
    expect(flushOnQuit).toBeGreaterThan(captureOnQuit);
  });

  it('refreshes the Windows WebView surface after restoring normal startup bounds', () => {
    const restoreNormalStart = appSource.indexOf('const restoreNormalWindowBounds = async');
    const restoreNormalEnd = appSource.indexOf('const restoreWindowState = async', restoreNormalStart);
    const restoreNormalSource = appSource.slice(restoreNormalStart, restoreNormalEnd);
    const applyBounds = restoreNormalSource.indexOf('applyRestoredWindowBounds(bounds);');
    const waitForBounds = restoreNormalSource.indexOf('await waitForNativeWindowBounds(appliedBounds);');
    const refreshSurface = restoreNormalSource.indexOf('await tryRefreshStartupWebViewBounds();');

    expect(restoreNormalStart).toBeGreaterThanOrEqual(0);
    expect(restoreNormalEnd).toBeGreaterThan(restoreNormalStart);
    expect(applyBounds).toBeGreaterThanOrEqual(0);
    expect(waitForBounds).toBeGreaterThan(applyBounds);
    expect(refreshSurface).toBeGreaterThan(waitForBounds);
  });

  it('keeps the resize minimise probe independent from DPR debounce and clears it on unmount', () => {
    const scaleEffectStart = appSource.indexOf('let minimisedCheckTimer: number | null = null;');
    const dprScheduleStart = appSource.indexOf('const scheduleDevicePixelRatioCheck = (trigger: WindowsScaleCheckTrigger) => {', scaleEffectStart);
    const activationScheduleStart = appSource.indexOf('const scheduleActivationFix = () => {', dprScheduleStart);
    const resizeHandlerStart = appSource.indexOf('const handleWindowResize = () => {', activationScheduleStart);
    const startupFixStart = appSource.indexOf('// Windows 冷启动：', resizeHandlerStart);
    const schedulerStart = appSource.indexOf('fallbackIntervalMs: WINDOWS_SCALE_FALLBACK_INTERVAL_MS,', startupFixStart);
    const cleanupStart = appSource.indexOf('return () => {', schedulerStart);
    const cleanupEnd = appSource.indexOf('cleanupWindowActivityScheduler();', cleanupStart);

    expect([scaleEffectStart, dprScheduleStart, activationScheduleStart, resizeHandlerStart, startupFixStart, schedulerStart, cleanupStart, cleanupEnd]
      .every((index) => index >= 0)).toBe(true);
    const resizeHandlerSource = appSource.slice(resizeHandlerStart, startupFixStart);
    const minimiseProbeIndex = resizeHandlerSource.indexOf('rememberMinimisedStateSoon();');
    const dprCheckIndex = resizeHandlerSource.indexOf("scheduleDevicePixelRatioCheck('resize');");
  });

  it('keeps button loading indicators animated when reduced motion is enabled', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.gonavi-settings-center-modal \.ant-btn-loading-icon \.anticon-spin \{[^}]*animation-duration: 1s !important;[^}]*animation-iteration-count: infinite !important;[^}]*\}/,
    );
  });

  it('waits for the unsaved SQL confirmation before continuing an update install request', () => {
    const quitHandlerStart = appSource.indexOf('const handleApplicationQuitRequest = useCallback(async (');
    const quitHandlerEnd = appSource.indexOf('const handleInstallUpdateRequest = useCallback', quitHandlerStart);
    const quitHandlerSource = appSource.slice(quitHandlerStart, quitHandlerEnd);

    expect(quitHandlerStart).toBeGreaterThanOrEqual(0);
    expect(quitHandlerEnd).toBeGreaterThan(quitHandlerStart);
    expect(quitHandlerSource).toContain('await new Promise<void>((resolve) => {');
    expect(quitHandlerSource).toContain('const finish = () => {');
    expect(quitHandlerSource).toContain('await runConfirmedActionAndFinish();');
    expect(quitHandlerSource).toContain('centered: true,');

    const installRequestSource = appSource.slice(quitHandlerEnd);
    const closeInstancesModalStart = installRequestSource.indexOf("title: t('app.about.update_install_confirm.close_instances_title'");
    const closeInstancesModalSource = installRequestSource.slice(closeInstancesModalStart);
    expect(closeInstancesModalStart).toBeGreaterThanOrEqual(0);
    expect(closeInstancesModalSource).toContain('centered: true,');
    expect(closeInstancesModalSource).toContain('await handleInstallFromProgress(true);');
    expect(closeInstancesModalSource).not.toContain('await handleApplicationQuitRequest(');
  });
});
