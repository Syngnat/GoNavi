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
const driverWorkbenchSource = readFileSync(
  fileURLToPath(new globalThis.URL('./components/DriverManagerWorkbench.tsx', import.meta.url)),
  'utf8',
);
const driverModalSource = readFileSync(
  fileURLToPath(new globalThis.URL('./components/DriverManagerModal.tsx', import.meta.url)),
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
    expect(appearanceEffectSource).toContain("document.body.setAttribute('data-ui-version', 'v2');");
  });

  it('exposes toolbar button overrides from the theme settings pane', () => {
    expect(appSource.match(/<ToolbarButtonAppearanceSettings \/>/g)).toHaveLength(1);

    const settingsStart = appSource.indexOf('const renderThemeSettingsContentV2 =');
    const settingsEnd = appSource.indexOf(
      'const renderThemeSettingsContent =',
      settingsStart,
    );
    const settingsSource = appSource.slice(settingsStart, settingsEnd);

    expect(settingsStart).toBeGreaterThanOrEqual(0);
    expect(settingsEnd).toBeGreaterThan(settingsStart);
    expect(settingsSource).toContain('<ToolbarButtonAppearanceSettings />');
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

  it('uses a persistent settings tree instead of a back-to-list drill-in', () => {
    expect(appSource).toContain('<SettingsCenterTreeNav');
    expect(appSource).toContain('buildSettingsCenterWorkbenchTab');
    expect(appSource).toContain('SettingsCenterWorkbenchRegistrar');
    expect(appSource).not.toMatch(/rootClassName=\{`gonavi-settings-center-modal/);
    expect(appSource).toContain("return { key: 'language', group }");
    expect(appSource).toContain("return { key: 'proxy', group }");
    expect(appSource).toContain("return { key: 'data-root-application', group }");
    expect(appSource).not.toContain('handleBackFromSettingsCenterPane');
    expect(appSource).not.toContain('gonavi-settings-center-group-tab');
    expect(appSource).not.toContain("t('common.back_to_settings')");
    expect(appSource).toContain("key: `theme-${section.value}`");
    expect(appSource).toContain('renderThemeSettingsContent({ hideSectionTabs: true })');
    expect(appSource).toContain('AI_SETTINGS_NAV_ITEMS.map');
    expect(appSource).toContain("key: `ai-${item.key}`");
    expect(appSource).toContain("key: 'ai-providers-connected'");
    expect(appSource).toContain("key: 'data-root-application'");
    expect(appSource).toContain("key: 'data-root-agent'");
    expect(appSource).toContain("key: 'data-root-saved-queries'");
    expect(appSource).toContain("handleOpenToolCenterPane('config', 'data-root-agent')");
    expect(appSource).toContain("handleOpenToolCenterPane('config', 'data-root-saved-queries')");
    expect(appSource).toContain('onProvidersViewChange={setAiSettingsProviderView}');
    expect(appSource).toContain('onCloseHost={handleCancelSettingsCenterPane}');
    expect(appSource).toContain("handleOpenToolCenterPane('workspace', 'drivers')");
    expect(appSource).toContain("activeSettingsCenterPane.key === 'drivers'");
    expect(appSource).not.toMatch(/handleCancelSettingsCenterPane\(\);\s*handleOpenDriverManagerWorkbench\(\);/);
    expect(appSource).toContain("handleOpenToolCenterPane('config', 'import')");
    expect(appSource).toContain("handleOpenToolCenterPane('config', 'export')");
    expect(appSource).toContain("handleOpenToolCenterPane('config', 'connection-health')");
    expect(appSource).toContain("activeSettingsCenterPane.key === 'connection-health'");
    expect(appSource).not.toMatch(/handleCancelSettingsCenterPane\(\);\s*handleOpenConnectionHealth\(\);/);
    expect(appSource).toContain("handleOpenDataSyncWorkbench('schemaCompare')");
    expect(appSource).toContain("handleOpenDataSyncWorkbench('dataCompare')");
    expect(appSource).toContain("handleOpenDataSyncWorkbench('sync')");
    expect(appSource).not.toContain('LazyDataSyncWorkbench');
    expect(appSource).not.toMatch(/handleCancelSettingsCenterPane\(\);\s*addTab\(buildDataSyncWorkbenchTab/);
    expect(appSource).toContain('hideSidebar');
    expect(appSource).toContain('section={aiSettingsSection}');
    expect(appSource).toContain("title: t('app.settings.entry.about.title')");
    expect(appSource).toMatch(/key: 'about' as const,[\s\S]*?items: \[\],/);
    expect(appSource).toContain('className="gonavi-about-link-grid"');
    expect(appSource).toContain("className=\"gonavi-about-identity\"");
    expect(appSource).not.toMatch(/className="gonavi-about-identity"[\s\S]*?<TagOutlined \/>[\s\S]*?aboutDisplayVersion/);
    expect(appSource).not.toMatch(/className="gonavi-about-identity"[\s\S]*?UpCircleOutlined/);
    expect(appSource).not.toContain("app.about.hero.update_available_version");
    expect(appSource).toContain("t('app.about.version.current')");
    expect(appSource).toContain("t('app.about.project.hualong.title')");
    expect(appSource).toContain('https://api.hualong.online/');
    expect(appSource).toContain('/sponsors/hualong-mark.png');
    expect(appSource).toContain('gonavi-about-project-entry-logo');
    expect(appSource).toContain("t('app.about.sponsors')");
    expect(appCss).toContain('.gonavi-about-project-entry-logo');
    expect(appSource).toContain('className="gonavi-about-download-source"');
    expect(appCss).toMatch(/\.gonavi-about-link-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
    expect(appSource).not.toContain('apismart');
    expect(appSource).not.toContain("gridTemplateColumns: 'minmax(0, 1.15fr) minmax(260px, 0.85fr)'");
    expect(appCss).toContain('grid-template-columns: 220px minmax(0, 1fr) !important;');
  });

  it('keeps connection import, export, and health checks inside settings panes', () => {
    expect(appSource).toContain("activeSettingsCenterPane.key === 'import'");
    expect(appSource).toContain('<ConnectionImportSettingsPanel');
    expect(appSource).toContain("setActiveSettingsCenterPane({ key: 'export', group: sourceGroup })");
    expect(appSource).toMatch(/isConnectionPackageSettingsPaneKey\(activeSettingsCenterPane\.key\)[\s\S]*?<ConnectionPackagePasswordModal[\s\S]*?embedded/);
    expect(appSource).toContain("activeSettingsCenterPane.key === 'connection-health'");
    expect(appSource).toMatch(/activeSettingsCenterPane\.key === 'connection-health'[\s\S]*?<ConnectionHealthModal[\s\S]*?embedded/);
    expect(appSource).not.toContain('isConnectionHealthModalOpen');

    const toolCenterGroupsStart = appSource.indexOf('const toolCenterGroups:');
    const importEntryStart = appSource.indexOf("key: 'import',", toolCenterGroupsStart);
    const exportEntryStart = appSource.indexOf("key: 'export',", importEntryStart);
    const importEntrySource = appSource.slice(importEntryStart, exportEntryStart);
    expect(importEntrySource).toContain("handleOpenToolCenterPane('config', 'import')");
    expect(importEntrySource).not.toContain('handleImportConnections');

    const titlebarImportStart = appSource.indexOf("if (spec.action === 'import-connections')");
    const titlebarExportStart = appSource.indexOf("if (spec.action === 'export-connections')", titlebarImportStart);
    const titlebarImportSource = appSource.slice(titlebarImportStart, titlebarExportStart);
    expect(titlebarImportSource).toContain("handleOpenToolCenterPane('config', 'import')");
    expect(titlebarImportSource).not.toContain('handleImportConnections');
  });

  it('keeps button loading indicators animated when reduced motion is enabled', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.gonavi-settings-center-modal \.ant-btn-loading-icon \.anticon-spin \{[^}]*animation-duration: 1s !important;[^}]*animation-iteration-count: infinite !important;[^}]*\}/,
    );
  });

  it('switches mirrors in place from About and Driver Manager without navigating settings', () => {
    const aboutStart = appSource.indexOf('className="gonavi-about-download-source"');
    const aboutEnd = appSource.indexOf('</section>', aboutStart);
    const aboutSource = appSource.slice(aboutStart, aboutEnd);
    const driverPaneStart = appSource.indexOf("activeSettingsCenterPane.key === 'drivers'");
    const driverPaneEnd = appSource.indexOf("activeSettingsCenterPane.key === 'snippet-settings'", driverPaneStart);
    const driverPaneSource = appSource.slice(driverPaneStart, driverPaneEnd);

    expect(aboutSource).toContain('getNextDownloadSource(downloadSource)');
    expect(aboutSource).toContain('handleDownloadSourceChange');
    expect(aboutSource).not.toContain('handleOpenDownloadSourceSettings');
    expect(driverPaneSource).toContain('onSwitchDownloadSource');
    expect(driverPaneSource).not.toContain("handleOpenSettingsCenterPane('services', 'download-source')");
    expect(driverWorkbenchSource).toContain('handleSwitchDownloadSource');
    expect(driverWorkbenchSource).not.toContain('requestDownloadSourceSettings');
    expect(driverModalSource).toContain('onSwitchDownloadSource');
    expect(driverModalSource).not.toContain('onOpenDownloadSourceSettings');
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
