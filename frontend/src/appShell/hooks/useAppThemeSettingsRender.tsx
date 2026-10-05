
import { Switch, Input, Button } from 'antd';
import {
  DEFAULT_UI_SCALE,
  DEFAULT_FONT_SIZE,
} from '../appSettingsConstants';
import { DEFAULT_APPEARANCE } from '../../store';
import type { AppCoreStateApi } from './useAppCoreState';
import type { AppAboutSettingsRenderApi } from './useAppAboutSettingsRender';
import type { AppProxySettingsApi } from './useAppProxySettings';
import type { AppShellStateApi } from './useAppShellState';
import type { AppAntdThemeApi } from './useAppAntdTheme';
import type { AppSecurityUpdateApi } from './useAppSecurityUpdate';
import { ThemeModeSettingsSection } from '../settings/ThemeModeSettingsSection';
import { ThemeAppearanceSettingsSection } from '../settings/ThemeAppearanceSettingsSection';
import { TabDisplaySettingsSection } from '../settings/TabDisplaySettingsSection';
import { DataTableSettingsFields } from '../settings/DataTableSettingsFields';

export interface UseAppThemeSettingsRenderInput {
  t: AppCoreStateApi['t'];
  themeSettingsSections: AppAboutSettingsRenderApi['themeSettingsSections'];
  themeModalSection: AppProxySettingsApi['themeModalSection'];
  setThemeModalSection: AppProxySettingsApi['setThemeModalSection'];
  renderThemeSettingsSection: AppAboutSettingsRenderApi['renderThemeSettingsSection'];
  effectiveThemePreference: AppCoreStateApi['effectiveThemePreference'];
  selectPresetTheme: AppCoreStateApi['selectPresetTheme'];
  renderThemeModePreview: AppAboutSettingsRenderApi['renderThemeModePreview'];
  renderThemeSettingsRow: AppAboutSettingsRenderApi['renderThemeSettingsRow'];
  effectiveUiScale: AppCoreStateApi['effectiveUiScale'];
  setUiScale: AppCoreStateApi['setUiScale'];
  effectiveFontSize: AppCoreStateApi['effectiveFontSize'];
  setFontSize: AppCoreStateApi['setFontSize'];
  effectiveSidebarRailScale: AppCoreStateApi['effectiveSidebarRailScale'];
  setAppearance: AppCoreStateApi['setAppearance'];
  appearance: AppCoreStateApi['appearance'];
  isFontFamiliesLoading: AppShellStateApi['isFontFamiliesLoading'];
  uiFontOptions: AppShellStateApi['uiFontOptions'];
  filterFontOption: AppAntdThemeApi['filterFontOption'];
  renderFontOptionLabel: AppAntdThemeApi['renderFontOptionLabel'];
  fontFamiliesLoadError: AppShellStateApi['fontFamiliesLoadError'];
  installedFontFamilies: AppShellStateApi['installedFontFamilies'];
  linuxCJKFontInstallHint: AppShellStateApi['linuxCJKFontInstallHint'];
  hasLoadedInstalledFontsRef: AppShellStateApi['hasLoadedInstalledFontsRef'];
  darkMode: AppCoreStateApi['darkMode'];
  monoFontOptions: AppShellStateApi['monoFontOptions'];
  newQuerySqlTemplate: AppCoreStateApi['newQuerySqlTemplate'];
  tabDisplaySettingsPanelRef: AppProxySettingsApi['tabDisplaySettingsPanelRef'];
  tabDisplaySettings: AppCoreStateApi['tabDisplaySettings'];
  setTabDisplayLayout: AppCoreStateApi['setTabDisplayLayout'];
  effectiveTabEnvironmentAccentThickness: AppCoreStateApi['effectiveTabEnvironmentAccentThickness'];
  tabDisplayElementOrder: AppCoreStateApi['tabDisplayElementOrder'];
  visibleTabDisplayElementKeys: AppCoreStateApi['visibleTabDisplayElementKeys'];
  focusedTabDisplayElementKey: AppShellStateApi['focusedTabDisplayElementKey'];
  setFocusedTabDisplayElementKey: AppShellStateApi['setFocusedTabDisplayElementKey'];
  v2AntPrimaryColor: AppAntdThemeApi['v2AntPrimaryColor'];
  overlayTheme: AppSecurityUpdateApi['overlayTheme'];
  utilityMutedTextStyle: AppSecurityUpdateApi['utilityMutedTextStyle'];
  v2AntPrimaryBgColor: AppAntdThemeApi['v2AntPrimaryBgColor'];
  resolvedMonoFontFamily: AppShellStateApi['resolvedMonoFontFamily'];
  updateTabDisplayElementVisibility: AppCoreStateApi['updateTabDisplayElementVisibility'];
  getTabDisplayElementLabel: AppCoreStateApi['getTabDisplayElementLabel'];
  getTabDisplayElementDescription: AppCoreStateApi['getTabDisplayElementDescription'];
  setTabDisplayElementRow: AppCoreStateApi['setTabDisplayElementRow'];
  moveTabDisplayElement: AppCoreStateApi['moveTabDisplayElement'];
  tableDoubleClickAction: AppCoreStateApi['tableDoubleClickAction'];
  queryTableCtrlClickAction: AppCoreStateApi['queryTableCtrlClickAction'];
  sqlEditorFontSizeFollowsGlobal: AppCoreStateApi['sqlEditorFontSizeFollowsGlobal'];
  effectiveSqlEditorFontSize: AppCoreStateApi['effectiveSqlEditorFontSize'];
  dataTableFontSizeFollowsGlobal: AppCoreStateApi['dataTableFontSizeFollowsGlobal'];
  effectiveDataTableFontSize: AppCoreStateApi['effectiveDataTableFontSize'];
  sidebarTreeFontSizeFollowsGlobal: AppCoreStateApi['sidebarTreeFontSizeFollowsGlobal'];
  effectiveSidebarTreeFontSize: AppCoreStateApi['effectiveSidebarTreeFontSize'];
  startupMaximised: AppCoreStateApi['startupMaximised'];
  setStartupMaximised: AppCoreStateApi['setStartupMaximised'];
}

export const useAppThemeSettingsRender = ({
  t, themeSettingsSections, themeModalSection, setThemeModalSection, renderThemeSettingsSection,
  effectiveThemePreference, selectPresetTheme, renderThemeModePreview, renderThemeSettingsRow,
  effectiveUiScale, setUiScale, effectiveFontSize, setFontSize, effectiveSidebarRailScale,
  setAppearance, appearance, isFontFamiliesLoading, uiFontOptions, filterFontOption,
  renderFontOptionLabel, fontFamiliesLoadError, installedFontFamilies, linuxCJKFontInstallHint,
  hasLoadedInstalledFontsRef, darkMode, monoFontOptions, newQuerySqlTemplate,
  tabDisplaySettingsPanelRef, tabDisplaySettings, setTabDisplayLayout,
  effectiveTabEnvironmentAccentThickness, tabDisplayElementOrder, visibleTabDisplayElementKeys,
  focusedTabDisplayElementKey, setFocusedTabDisplayElementKey, v2AntPrimaryColor, overlayTheme,
  utilityMutedTextStyle, v2AntPrimaryBgColor, resolvedMonoFontFamily,
  updateTabDisplayElementVisibility, getTabDisplayElementLabel, getTabDisplayElementDescription,
  setTabDisplayElementRow, moveTabDisplayElement, tableDoubleClickAction, queryTableCtrlClickAction,
  sqlEditorFontSizeFollowsGlobal, effectiveSqlEditorFontSize, dataTableFontSizeFollowsGlobal,
  effectiveDataTableFontSize, sidebarTreeFontSizeFollowsGlobal, effectiveSidebarTreeFontSize,
  startupMaximised, setStartupMaximised,
}: UseAppThemeSettingsRenderInput) => {
  const renderThemeSettingsContentV2 = (options?: { hideSectionTabs?: boolean }) => (
              <div className="gonavi-theme-settings" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: '4px 4px 0',
                  height: '100%',
                  minHeight: 0,
                  overflow: 'hidden',
                  boxSizing: 'border-box',
              }}>
                  {options?.hideSectionTabs ? null : (
                  <div style={{ flexShrink: 0, display: 'grid', gap: 4 }}>
                      <div className="gonavi-settings-tabs" role="tablist" aria-label={t('app.settings.entry.theme.title')}>
                          {themeSettingsSections.map((item, itemIndex) => {
                              const active = themeModalSection === item.value;
                              return (
                                  <button
                                      key={item.value}
                                      id={`gonavi-theme-settings-tab-${item.value}`}
                                      type="button"
                                      role="tab"
                                      aria-selected={active}
                                      aria-controls={`gonavi-theme-settings-panel-${item.value}`}
                                      tabIndex={active ? 0 : -1}
                                      className={`gonavi-settings-tab${active ? ' is-active' : ''}`}
                                      onClick={() => setThemeModalSection(item.value)}
                                      onKeyDown={(event) => {
                                          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
                                              return;
                                          }
                                          event.preventDefault();
                                          const nextIndex = event.key === 'Home'
                                              ? 0
                                              : event.key === 'End'
                                                  ? themeSettingsSections.length - 1
                                                  : event.key === 'ArrowRight'
                                                      ? (itemIndex + 1) % themeSettingsSections.length
                                                      : (itemIndex - 1 + themeSettingsSections.length) % themeSettingsSections.length;
                                          setThemeModalSection(themeSettingsSections[nextIndex].value);
                                          const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
                                          tabs?.[nextIndex]?.focus();
                                      }}
                                  >
                                      <span className="gonavi-settings-tab-icon">{item.icon}</span>
                                      <span>{item.label}</span>
                                  </button>
                              );
                          })}
                      </div>
                  </div>
                  )}
                  <div
                    key={themeModalSection}
                    id={`gonavi-theme-settings-panel-${themeModalSection}`}
                    role={options?.hideSectionTabs ? undefined : 'tabpanel'}
                    aria-labelledby={options?.hideSectionTabs ? undefined : `gonavi-theme-settings-tab-${themeModalSection}`}
                    className="gonavi-settings-center-pane-scroll"
                    style={{
                        minWidth: 0,
                        minHeight: 0,
                        flex: 1,
                        overflowY: 'auto',
                        /* visible：避免 Slider 两端手柄被横向裁切 */
                        overflowX: 'visible',
                        overscrollBehavior: 'contain',
                        paddingRight: 4,
                        paddingLeft: 2,
                        paddingBottom: 20,
                        scrollbarGutter: 'auto',
                    }}
                  >
                      {themeModalSection === 'theme' ? (
                          <ThemeModeSettingsSection
                            renderThemeSettingsSection={renderThemeSettingsSection} t={t}
                            effectiveThemePreference={effectiveThemePreference}
                            selectPresetTheme={selectPresetTheme}
                            renderThemeModePreview={renderThemeModePreview}
                          />
                      ) : themeModalSection === 'appearance' ? (
                          <ThemeAppearanceSettingsSection
                            renderThemeSettingsSection={renderThemeSettingsSection}
                            options={options} t={t}
                            renderThemeSettingsRow={renderThemeSettingsRow}
                            effectiveUiScale={effectiveUiScale} setUiScale={setUiScale}
                            effectiveFontSize={effectiveFontSize} setFontSize={setFontSize}
                            effectiveSidebarRailScale={effectiveSidebarRailScale}
                            setAppearance={setAppearance} appearance={appearance}
                            isFontFamiliesLoading={isFontFamiliesLoading}
                            uiFontOptions={uiFontOptions} filterFontOption={filterFontOption}
                            renderFontOptionLabel={renderFontOptionLabel}
                            fontFamiliesLoadError={fontFamiliesLoadError}
                            installedFontFamilies={installedFontFamilies}
                            linuxCJKFontInstallHint={linuxCJKFontInstallHint}
                            hasLoadedInstalledFontsRef={hasLoadedInstalledFontsRef}
                            darkMode={darkMode} monoFontOptions={monoFontOptions}
                          />
                      ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {renderThemeSettingsSection(
                                  t('app.theme.query_template.title'),
                                  <>
                                      <div className="gonavi-settings-section-hint" style={{ marginTop: 0 }}>{t('app.theme.query_template.description')}</div>
                                      <Input.TextArea
                                          value={newQuerySqlTemplate}
                                          autoSize={{ minRows: 3, maxRows: 8 }}
                                          spellCheck={false}
                                          onChange={(event) => setAppearance({ newQuerySqlTemplate: event.target.value })}
                                          style={{ fontFamily: 'var(--gn-font-mono)' }}
                                      />
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                                          <div className="gonavi-settings-inline-meta" style={{ marginTop: 0 }}>{t('app.theme.query_template.hint')}</div>
                                          <Button
                                              size="small"
                                              disabled={appearance.newQuerySqlTemplate === null}
                                              onClick={() => setAppearance({ newQuerySqlTemplate: null })}
                                          >
                                              {t('app.theme.query_template.reset_default')}
                                          </Button>
                                      </div>
                                  </>,
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.table_alias.title'),
                                  <div style={{ display: 'grid', gap: 12 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                          <div className="gonavi-settings-section-hint" style={{ marginTop: 0 }}>
                                              {t('app.theme.table_alias.description')}
                                          </div>
                                          <Switch
                                              checked={appearance.autoAddTableAlias !== false}
                                              onChange={(checked) => setAppearance({ autoAddTableAlias: checked })}
                                          />
                                      </div>
                                      <div style={{ display: 'grid', gap: 8 }}>
                                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                              <div>
                                                  <div>{t('app.theme.table_alias.custom_prefix.title')}</div>
                                                  <div className="gonavi-settings-section-hint" style={{ marginTop: 2 }}>
                                                      {t('app.theme.table_alias.custom_prefix.description')}
                                                  </div>
                                              </div>
                                              <Switch
                                                  checked={appearance.customTableAliasPrefixEnabled}
                                                  disabled={appearance.autoAddTableAlias === false}
                                                  onChange={(checked) => setAppearance({ customTableAliasPrefixEnabled: checked })}
                                              />
                                          </div>
                                          <Input
                                              value={appearance.customTableAliasPrefix}
                                              maxLength={24}
                                              placeholder={t('app.theme.table_alias.custom_prefix.placeholder')}
                                              disabled={appearance.autoAddTableAlias === false || !appearance.customTableAliasPrefixEnabled}
                                              onChange={(event) => setAppearance({ customTableAliasPrefix: event.target.value })}
                                          />
                                      </div>
                                  </div>,
                              )}
                              <TabDisplaySettingsSection
                                tabDisplaySettingsPanelRef={tabDisplaySettingsPanelRef} t={t}
                                renderThemeSettingsRow={renderThemeSettingsRow}
                                tabDisplaySettings={tabDisplaySettings}
                                setTabDisplayLayout={setTabDisplayLayout}
                                effectiveTabEnvironmentAccentThickness={effectiveTabEnvironmentAccentThickness}
                                setAppearance={setAppearance}
                                tabDisplayElementOrder={tabDisplayElementOrder}
                                visibleTabDisplayElementKeys={visibleTabDisplayElementKeys}
                                focusedTabDisplayElementKey={focusedTabDisplayElementKey}
                                setFocusedTabDisplayElementKey={setFocusedTabDisplayElementKey}
                                v2AntPrimaryColor={v2AntPrimaryColor} overlayTheme={overlayTheme}
                                v2AntPrimaryBgColor={v2AntPrimaryBgColor}
                                resolvedMonoFontFamily={resolvedMonoFontFamily}
                                darkMode={darkMode}
                                updateTabDisplayElementVisibility={updateTabDisplayElementVisibility}
                                getTabDisplayElementLabel={getTabDisplayElementLabel}
                                utilityMutedTextStyle={utilityMutedTextStyle}
                                getTabDisplayElementDescription={getTabDisplayElementDescription}
                                setTabDisplayElementRow={setTabDisplayElementRow}
                                moveTabDisplayElement={moveTabDisplayElement}
                              />
                              {renderThemeSettingsSection(
                                  t('app.theme.data_table.title'),
                                  <DataTableSettingsFields
                                    renderThemeSettingsRow={renderThemeSettingsRow} t={t}
                                    appearance={appearance} setAppearance={setAppearance}
                                    tableDoubleClickAction={tableDoubleClickAction}
                                    queryTableCtrlClickAction={queryTableCtrlClickAction}
                                    sqlEditorFontSizeFollowsGlobal={sqlEditorFontSizeFollowsGlobal}
                                    effectiveSqlEditorFontSize={effectiveSqlEditorFontSize}
                                    dataTableFontSizeFollowsGlobal={dataTableFontSizeFollowsGlobal}
                                    effectiveDataTableFontSize={effectiveDataTableFontSize}
                                    sidebarTreeFontSizeFollowsGlobal={sidebarTreeFontSizeFollowsGlobal}
                                    effectiveSidebarTreeFontSize={effectiveSidebarTreeFontSize}
                                  />,
                              )}
                              {renderThemeSettingsSection(
                                  t('app.theme.startup_window.title'),
                                  renderThemeSettingsRow({
                                      label: t('app.theme.startup_window.maximised'),
                                      hint: t('app.theme.startup_window.hint'),
                                      control: (
                                          <Switch checked={startupMaximised} onChange={(checked) => setStartupMaximised(checked)} />
                                      ),
                                  }),
                              )}
                              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 12 }}>
                                  <Button
                                      onClick={() => {
                                          setUiScale(DEFAULT_UI_SCALE);
                                          setFontSize(DEFAULT_FONT_SIZE);
                                          setAppearance({ ...DEFAULT_APPEARANCE });
                                      }}
                                  >
                                      {t('app.theme.action.restore_defaults')}
                                  </Button>
                              </div>
                          </div>
                      )}
                  </div>
              </div>
  );

  const renderThemeSettingsContent = (options?: { hideSectionTabs?: boolean }) => (
    renderThemeSettingsContentV2(options)
  );
  return { renderThemeSettingsContent };
};

export type AppThemeSettingsRenderApi = ReturnType<typeof useAppThemeSettingsRender>;
