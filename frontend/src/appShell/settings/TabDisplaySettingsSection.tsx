import { Segmented, Switch, Button } from 'antd';
import type { TabDisplayLayout } from '../../utils/tabDisplay';
import { ThemeSettingsSlider } from '../ThemeSettingsSlider';
import {
  MIN_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  MAX_TAB_ENVIRONMENT_ACCENT_THICKNESS,
  sanitizeTabEnvironmentAccentThickness,
} from '../../store';
import { TAB_ENVIRONMENT_ACCENT_THICKNESS_SLIDER_MARKS } from '../appSettingsConstants';
import type { UseAppThemeSettingsRenderInput } from '../hooks/useAppThemeSettingsRender';

export interface TabDisplaySettingsSectionProps {
  tabDisplaySettingsPanelRef: UseAppThemeSettingsRenderInput['tabDisplaySettingsPanelRef'];
  t: UseAppThemeSettingsRenderInput['t'];
  renderThemeSettingsRow: UseAppThemeSettingsRenderInput['renderThemeSettingsRow'];
  tabDisplaySettings: UseAppThemeSettingsRenderInput['tabDisplaySettings'];
  setTabDisplayLayout: UseAppThemeSettingsRenderInput['setTabDisplayLayout'];
  effectiveTabEnvironmentAccentThickness: UseAppThemeSettingsRenderInput['effectiveTabEnvironmentAccentThickness'];
  setAppearance: UseAppThemeSettingsRenderInput['setAppearance'];
  tabDisplayElementOrder: UseAppThemeSettingsRenderInput['tabDisplayElementOrder'];
  visibleTabDisplayElementKeys: UseAppThemeSettingsRenderInput['visibleTabDisplayElementKeys'];
  focusedTabDisplayElementKey: UseAppThemeSettingsRenderInput['focusedTabDisplayElementKey'];
  setFocusedTabDisplayElementKey: UseAppThemeSettingsRenderInput['setFocusedTabDisplayElementKey'];
  v2AntPrimaryColor: UseAppThemeSettingsRenderInput['v2AntPrimaryColor'];
  overlayTheme: UseAppThemeSettingsRenderInput['overlayTheme'];
  v2AntPrimaryBgColor: UseAppThemeSettingsRenderInput['v2AntPrimaryBgColor'];
  resolvedMonoFontFamily: UseAppThemeSettingsRenderInput['resolvedMonoFontFamily'];
  darkMode: UseAppThemeSettingsRenderInput['darkMode'];
  updateTabDisplayElementVisibility: UseAppThemeSettingsRenderInput['updateTabDisplayElementVisibility'];
  getTabDisplayElementLabel: UseAppThemeSettingsRenderInput['getTabDisplayElementLabel'];
  utilityMutedTextStyle: UseAppThemeSettingsRenderInput['utilityMutedTextStyle'];
  getTabDisplayElementDescription: UseAppThemeSettingsRenderInput['getTabDisplayElementDescription'];
  setTabDisplayElementRow: UseAppThemeSettingsRenderInput['setTabDisplayElementRow'];
  moveTabDisplayElement: UseAppThemeSettingsRenderInput['moveTabDisplayElement'];
}

export const TabDisplaySettingsSection = ({
  tabDisplaySettingsPanelRef, t, renderThemeSettingsRow, tabDisplaySettings, setTabDisplayLayout,
  effectiveTabEnvironmentAccentThickness, setAppearance, tabDisplayElementOrder,
  visibleTabDisplayElementKeys, focusedTabDisplayElementKey, setFocusedTabDisplayElementKey,
  v2AntPrimaryColor, overlayTheme, v2AntPrimaryBgColor, resolvedMonoFontFamily, darkMode,
  updateTabDisplayElementVisibility, getTabDisplayElementLabel, utilityMutedTextStyle,
  getTabDisplayElementDescription, setTabDisplayElementRow, moveTabDisplayElement,
}: TabDisplaySettingsSectionProps) => (
  <section className="gonavi-settings-section" ref={tabDisplaySettingsPanelRef}>
      <div className="gonavi-settings-section-title">{t('app.theme.tab_display.title')}</div>
      <div className="gonavi-settings-section-hint">{t('app.theme.tab_display.description')}</div>
      {renderThemeSettingsRow({
          label: t('app.theme.tab_display.title'),
          stacked: true,
          control: (
              <Segmented
                  className="gonavi-settings-segmented-choice"
                  block
                  options={[
                      { label: t('app.theme.tab_display.layout.single'), value: 'single' },
                      { label: t('app.theme.tab_display.layout.double'), value: 'double' },
                  ]}
                  value={tabDisplaySettings.layout}
                  onChange={(value) => setTabDisplayLayout(value as TabDisplayLayout)}
              />
          ),
      })}
      {renderThemeSettingsRow({
          label: t('app.theme.tab_display.environment_accent_thickness'),
          hint: t('app.theme.tab_display.environment_accent_thickness_hint'),
          stacked: true,
          control: (
              <ThemeSettingsSlider
                  min={MIN_TAB_ENVIRONMENT_ACCENT_THICKNESS}
                  max={MAX_TAB_ENVIRONMENT_ACCENT_THICKNESS}
                  step={1}
                  marks={TAB_ENVIRONMENT_ACCENT_THICKNESS_SLIDER_MARKS}
                  value={effectiveTabEnvironmentAccentThickness}
                  unit="px"
                  onChange={(value) => setAppearance({
                      tabEnvironmentAccentThickness: sanitizeTabEnvironmentAccentThickness(value),
                  })}
              />
          ),
      })}
      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
  {tabDisplayElementOrder.map((key) => {
              const checked = visibleTabDisplayElementKeys.has(key);
              const row = tabDisplaySettings.secondaryElements.includes(key) ? 'secondary' : 'primary';
              const currentRowElements = row === 'secondary'
                  ? tabDisplaySettings.secondaryElements
                  : tabDisplaySettings.primaryElements;
              const indexInRow = currentRowElements.indexOf(key);
              const canMoveUp = checked && indexInRow > 0;
              const canMoveDown = checked && indexInRow >= 0 && indexInRow < currentRowElements.length - 1;
              const isFocused = focusedTabDisplayElementKey === key;
              return (
                  <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      onClick={() => setFocusedTabDisplayElementKey(key)}
                      onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setFocusedTabDisplayElementKey(key);
                          }
                      }}
                      style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) auto',
                          gap: 10,
                          alignItems: 'center',
                          padding: '8px 2px 8px 10px',
                          borderRadius: 0,
                          border: 'none',
                          borderLeft: `3px solid ${isFocused
                              ? (v2AntPrimaryColor)
                              : 'transparent'}`,
                          borderBottom: `1px solid ${overlayTheme.divider}`,
                          boxShadow: 'none',
                          background: isFocused
                              ? (v2AntPrimaryBgColor)
                              : 'transparent',
                          cursor: 'pointer',
                          transition: 'border-color 140ms ease, background-color 140ms ease',
                      }}
                  >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                          <span style={{
                              width: 22,
                              height: 22,
                              borderRadius: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              fontFamily: resolvedMonoFontFamily,
                              fontSize: 'var(--gn-font-size-sm, 12px)',
                              fontWeight: 600,
                              background: 'transparent',
                              color: isFocused
                                  ? (v2AntPrimaryColor)
                                  : (darkMode ? 'rgba(255,255,255,0.56)' : 'rgba(16,24,40,0.5)'),
                          }}>
                              {checked && indexInRow >= 0 ? indexInRow + 1 : '-'}
                          </span>
                          <Switch
                              size="small"
                              checked={checked}
                              onClick={(_, event) => event.stopPropagation()}
                              onChange={(nextChecked) => updateTabDisplayElementVisibility(key, nextChecked)}
                          />
                          <div style={{ minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                  <span style={{ fontWeight: 600 }}>{getTabDisplayElementLabel(key)}</span>
                                  {isFocused ? (
                                      <span style={{
                                          fontSize: 'var(--gn-font-size-sm, 12px)',
                                          lineHeight: '16px',
                                          padding: '0 6px',
                                          borderRadius: 999,
                                          background: v2AntPrimaryBgColor,
                                          color: v2AntPrimaryColor,
                                      }}>
                                          {t('app.theme.tab_display.badge.current')}
                                      </span>
                                  ) : null}
                                  {checked && tabDisplaySettings.layout === 'double' ? (
                                      <span style={{
                                          fontSize: 'var(--gn-font-size-sm, 12px)',
                                          lineHeight: '16px',
                                          padding: '0 6px',
                                          borderRadius: 999,
                                          background: row === 'secondary'
                                              ? (darkMode ? 'rgba(56,189,248,0.14)' : 'rgba(2,132,199,0.08)')
                                              : (darkMode ? 'rgba(34,197,94,0.14)' : 'rgba(22,163,74,0.08)'),
                                          color: row === 'secondary'
                                              ? (darkMode ? '#7dd3fc' : '#0369a1')
                                              : (darkMode ? '#86efac' : '#15803d'),
                                      }}>
                                          {row === 'secondary'
                                              ? t('app.theme.tab_display.row.secondary')
                                              : t('app.theme.tab_display.row.primary')}
                                      </span>
                                  ) : null}
                              </div>
                              <div style={{ ...utilityMutedTextStyle, marginTop: 2 }}>{getTabDisplayElementDescription(key)}</div>
                          </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {tabDisplaySettings.layout === 'double' && checked ? (
                              <Segmented
                                  size="small"
                                  options={[
                                      { label: t('app.theme.tab_display.row.primary'), value: 'primary' },
                                      { label: t('app.theme.tab_display.row.secondary'), value: 'secondary' },
                                  ]}
                                  value={row}
                                  onChange={(value) => setTabDisplayElementRow(key, value as 'primary' | 'secondary')}
                                  onClick={(event) => event.stopPropagation()}
                              />
                          ) : null}
                          <Button
                              size="small"
                              disabled={!canMoveUp}
                              onClick={(event) => {
                                  event.stopPropagation();
                                  moveTabDisplayElement(key, -1);
                              }}
                          >
                              {t('app.theme.tab_display.action.move_up')}
                          </Button>
                          <Button
                              size="small"
                              disabled={!canMoveDown}
                              onClick={(event) => {
                                  event.stopPropagation();
                                  moveTabDisplayElement(key, 1);
                              }}
                          >
                              {t('app.theme.tab_display.action.move_down')}
                          </Button>
                      </div>
                  </div>
              );
          })}
      </div>
      <div className="gonavi-settings-inline-meta">
          {t('app.theme.tab_display.preview.prefix')}
          {tabDisplaySettings.layout === 'double' ? `${t('app.theme.tab_display.row.primary')} ` : ''}
          {tabDisplaySettings.primaryElements.map(getTabDisplayElementLabel).join(' / ') || t('app.theme.tab_display.preview.default_label')}
          {tabDisplaySettings.layout === 'double' && tabDisplaySettings.secondaryElements.length > 0
              ? t('app.theme.tab_display.preview.secondary', {
                  labels: tabDisplaySettings.secondaryElements.map(getTabDisplayElementLabel).join(' / '),
              })
              : ''}
          {focusedTabDisplayElementKey
              ? t('app.theme.tab_display.preview.focused', {
                  label: getTabDisplayElementLabel(focusedTabDisplayElementKey),
              })
              : ''}
      </div>
  </section>
);
