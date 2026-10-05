import { Switch, Select } from 'antd';
import { ThemeSettingsSlider } from '../ThemeSettingsSlider';
import {
  MIN_UI_SCALE,
  MAX_UI_SCALE,
  UI_SCALE_SLIDER_MARKS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  FONT_SIZE_SLIDER_MARKS,
  SIDEBAR_RAIL_SCALE_SLIDER_MARKS,
  OPACITY_SLIDER_MARKS,
  BLUR_SLIDER_MARKS,
} from '../appSettingsConstants';
import {
  MIN_V2_SIDEBAR_RAIL_SCALE,
  MAX_V2_SIDEBAR_RAIL_SCALE,
  sanitizeV2SidebarRailScale,
} from '../../store';
import {
  DEFAULT_UI_FONT_FAMILY,
  sanitizeFontFamilyInput,
  DEFAULT_MONO_FONT_FAMILY,
} from '../../utils/fontFamilies';
import { isWindowsPlatform } from '../../utils/appearance';
import type { UseAppThemeSettingsRenderInput } from '../hooks/useAppThemeSettingsRender';

export interface ThemeAppearanceSettingsSectionProps {
  renderThemeSettingsSection: UseAppThemeSettingsRenderInput['renderThemeSettingsSection'];
  options: { hideSectionTabs?: boolean } | undefined;
  t: UseAppThemeSettingsRenderInput['t'];
  renderThemeSettingsRow: UseAppThemeSettingsRenderInput['renderThemeSettingsRow'];
  effectiveUiScale: UseAppThemeSettingsRenderInput['effectiveUiScale'];
  setUiScale: UseAppThemeSettingsRenderInput['setUiScale'];
  effectiveFontSize: UseAppThemeSettingsRenderInput['effectiveFontSize'];
  setFontSize: UseAppThemeSettingsRenderInput['setFontSize'];
  effectiveSidebarRailScale: UseAppThemeSettingsRenderInput['effectiveSidebarRailScale'];
  setAppearance: UseAppThemeSettingsRenderInput['setAppearance'];
  appearance: UseAppThemeSettingsRenderInput['appearance'];
  isFontFamiliesLoading: UseAppThemeSettingsRenderInput['isFontFamiliesLoading'];
  uiFontOptions: UseAppThemeSettingsRenderInput['uiFontOptions'];
  filterFontOption: UseAppThemeSettingsRenderInput['filterFontOption'];
  renderFontOptionLabel: UseAppThemeSettingsRenderInput['renderFontOptionLabel'];
  fontFamiliesLoadError: UseAppThemeSettingsRenderInput['fontFamiliesLoadError'];
  installedFontFamilies: UseAppThemeSettingsRenderInput['installedFontFamilies'];
  linuxCJKFontInstallHint: UseAppThemeSettingsRenderInput['linuxCJKFontInstallHint'];
  hasLoadedInstalledFontsRef: UseAppThemeSettingsRenderInput['hasLoadedInstalledFontsRef'];
  darkMode: UseAppThemeSettingsRenderInput['darkMode'];
  monoFontOptions: UseAppThemeSettingsRenderInput['monoFontOptions'];
}

export const ThemeAppearanceSettingsSection = ({
  renderThemeSettingsSection, options, t, renderThemeSettingsRow, effectiveUiScale, setUiScale,
  effectiveFontSize, setFontSize, effectiveSidebarRailScale, setAppearance, appearance,
  isFontFamiliesLoading, uiFontOptions, filterFontOption, renderFontOptionLabel,
  fontFamiliesLoadError, installedFontFamilies, linuxCJKFontInstallHint, hasLoadedInstalledFontsRef,
  darkMode, monoFontOptions,
}: ThemeAppearanceSettingsSectionProps) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {renderThemeSettingsSection(
          // 设置中心侧栏已显示「显示与字体」，内容区不再重复分区标题
          options?.hideSectionTabs ? null : t('app.theme.nav.appearance.title'),
          <>
              {renderThemeSettingsRow({
                  label: t('app.theme.appearance.ui_scale_title'),
                  hint: t('app.theme.appearance.ui_scale_hint'),
                  stacked: true,
                  control: (
                      <ThemeSettingsSlider
                          min={MIN_UI_SCALE}
                          max={MAX_UI_SCALE}
                          step={0.05}
                          marks={UI_SCALE_SLIDER_MARKS}
                          value={effectiveUiScale}
                          unit="percent"
                          onChange={(v) => setUiScale(v)}
                      />
                  ),
              })}
              {renderThemeSettingsRow({
                  label: t('app.theme.appearance.font_size_title'),
                  stacked: true,
                  control: (
                      <ThemeSettingsSlider
                          min={MIN_FONT_SIZE}
                          max={MAX_FONT_SIZE}
                          step={1}
                          marks={FONT_SIZE_SLIDER_MARKS}
                          value={effectiveFontSize}
                          unit="px"
                          onChange={(v) => setFontSize(v)}
                      />
                  ),
              })}
              {renderThemeSettingsRow({
                  label: t('app.theme.appearance.sidebar_rail_scale_title'),
                  hint: t('app.theme.appearance.sidebar_rail_scale_hint'),
                  stacked: true,
                  control: (
                      <ThemeSettingsSlider
                          min={MIN_V2_SIDEBAR_RAIL_SCALE}
                          max={MAX_V2_SIDEBAR_RAIL_SCALE}
                          step={0.05}
                          marks={SIDEBAR_RAIL_SCALE_SLIDER_MARKS}
                          value={effectiveSidebarRailScale}
                          unit="percent"
                          onChange={(value) => setAppearance({
                              v2SidebarRailScale: sanitizeV2SidebarRailScale(value),
                          })}
                      />
                  ),
              })}
              {renderThemeSettingsRow({
                  label: t('app.theme.appearance.single_database_expansion_title'),
                  hint: t('app.theme.appearance.single_database_expansion_hint'),
                  control: (
                      <Switch
                          checked={appearance.sidebarSingleDatabaseExpansion === true}
                          onChange={(checked) => setAppearance({ sidebarSingleDatabaseExpansion: checked })}
                      />
                  ),
              })}
          </>,
      )}
      {renderThemeSettingsSection(
          t('app.theme.font_family.title'),
          <>
              <div style={{ padding: '8px 0' }}>
                  <div className="gonavi-settings-label" style={{ marginBottom: 8 }}>{t('app.theme.font_family.ui_title')}</div>
                  <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      loading={isFontFamiliesLoading}
                      placeholder={DEFAULT_UI_FONT_FAMILY}
                      value={appearance.customUIFontFamily ?? undefined}
                      onChange={(value) => setAppearance({
                          customUIFontFamily: sanitizeFontFamilyInput(value),
                      })}
                      onClear={() => setAppearance({ customUIFontFamily: null })}
                      options={uiFontOptions.map((option) => ({
                          value: option.value,
                          label: option.label,
                      }))}
                      filterOption={filterFontOption}
                      popupMatchSelectWidth
                      style={{ width: '100%' }}
                      optionRender={(option) => renderFontOptionLabel({
                          value: String(option.data.value),
                          label: String(option.data.label),
                      })}
                  />
                  <div className="gonavi-settings-inline-meta">
                      {fontFamiliesLoadError
                          ? t('app.theme.font_family.load_failed_fallback', { error: fontFamiliesLoadError })
                          : (installedFontFamilies.length > 0
                              ? t('app.theme.font_family.loaded_ui_hint', { count: installedFontFamilies.length })
                              : t('app.theme.font_family.loading_ui_hint'))}
                  </div>
                  {linuxCJKFontInstallHint && hasLoadedInstalledFontsRef.current && !isFontFamiliesLoading && !fontFamiliesLoadError ? (
                      <div className="gonavi-settings-alert" style={{ borderColor: darkMode ? 'rgba(250,204,21,0.28)' : 'rgba(217,119,6,0.22)', background: darkMode ? 'rgba(250,204,21,0.08)' : 'rgba(251,191,36,0.12)', color: darkMode ? 'rgba(254,249,195,0.92)' : '#92400e' }}>
                          {t('app.theme.font_family.linux_cjk_install_prefix')}
                          <span style={{ fontFamily: 'var(--gn-font-mono)', marginLeft: 6 }}>{linuxCJKFontInstallHint}</span>
                          {t('app.theme.font_family.linux_cjk_install_suffix')}
                      </div>
                  ) : null}
              </div>
              <div style={{ padding: '8px 0', borderTop: '1px solid var(--gn-settings-line)' }}>
                  <div className="gonavi-settings-label" style={{ marginBottom: 8 }}>{t('app.theme.font_family.mono_title')}</div>
                  <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      loading={isFontFamiliesLoading}
                      placeholder={DEFAULT_MONO_FONT_FAMILY}
                      value={appearance.customMonoFontFamily ?? undefined}
                      onChange={(value) => setAppearance({
                          customMonoFontFamily: sanitizeFontFamilyInput(value),
                      })}
                      onClear={() => setAppearance({ customMonoFontFamily: null })}
                      options={monoFontOptions.map((option) => ({
                          value: option.value,
                          label: option.label,
                      }))}
                      filterOption={filterFontOption}
                      popupMatchSelectWidth
                      style={{ width: '100%' }}
                      optionRender={(option) => renderFontOptionLabel({
                          value: String(option.data.value),
                          label: String(option.data.label),
                      })}
                  />
                  <div className="gonavi-settings-inline-meta">
                      {fontFamiliesLoadError
                          ? t('app.theme.font_family.mono_fallback_hint')
                          : t('app.theme.font_family.mono_hint')}
                  </div>
              </div>
          </>,
      )}
      {renderThemeSettingsSection(
          t('app.theme.appearance.transparency_blur_title'),
          <>
              {renderThemeSettingsRow({
                  label: t('app.theme.appearance.enable_transparency_blur'),
                  hint: t('app.theme.appearance.enable_transparency_blur_hint'),
                  control: (
                      <Switch
                          checked={appearance.enabled !== false}
                          onChange={(checked) => setAppearance({ enabled: checked })}
                      />
                  ),
              })}
              <div style={{ opacity: appearance.enabled !== false ? 1 : 0.55 }}>
                  {renderThemeSettingsRow({
                      label: t('app.theme.appearance.opacity_title'),
                      stacked: true,
                      control: (
                          <ThemeSettingsSlider
                              min={0.1}
                              max={1.0}
                              step={0.05}
                              marks={OPACITY_SLIDER_MARKS}
                              disabled={appearance.enabled === false}
                              value={appearance.opacity ?? 1.0}
                              unit="percent"
                              onChange={(v) => setAppearance({ opacity: v })}
                          />
                      ),
                  })}
                  {isWindowsPlatform() ? (
                      <div className="gonavi-settings-inline-meta">{t('app.theme.appearance.windows_acrylic_hint')}</div>
                  ) : (
                      renderThemeSettingsRow({
                          label: t('app.theme.appearance.blur_title'),
                          hint: t('app.theme.appearance.blur_hint'),
                          stacked: true,
                          control: (
                              <ThemeSettingsSlider
                                  min={0}
                                  max={20}
                                  step={1}
                                  marks={BLUR_SLIDER_MARKS}
                                  disabled={appearance.enabled === false}
                                  value={appearance.blur ?? 0}
                                  unit="px"
                                  onChange={(v) => setAppearance({ blur: v })}
                              />
                          ),
                      })
                  )}
              </div>
          </>,
      )}
  </div>
);
