import { CheckOutlined } from '@ant-design/icons';
import CustomThemeManager from '../../components/settings/CustomThemeManager';
import ToolbarButtonAppearanceSettings from '../../components/settings/ToolbarButtonAppearanceSettings';
import TitlebarActionsPlacementSettings from '../../components/settings/TitlebarActionsPlacementSettings';
import {
  SidebarActionsPlacementSettings,
  SidebarSearchModeSettings,
} from '../../components/settings/SidebarLayoutSettings';
import type { UseAppThemeSettingsRenderInput } from '../hooks/useAppThemeSettingsRender';

export interface ThemeModeSettingsSectionProps {
  renderThemeSettingsSection: UseAppThemeSettingsRenderInput['renderThemeSettingsSection'];
  t: UseAppThemeSettingsRenderInput['t'];
  effectiveThemePreference: UseAppThemeSettingsRenderInput['effectiveThemePreference'];
  selectPresetTheme: UseAppThemeSettingsRenderInput['selectPresetTheme'];
  renderThemeModePreview: UseAppThemeSettingsRenderInput['renderThemeModePreview'];
}

export const ThemeModeSettingsSection = ({
  renderThemeSettingsSection, t, effectiveThemePreference, selectPresetTheme,
  renderThemeModePreview,
}: ThemeModeSettingsSectionProps) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {renderThemeSettingsSection(
          t('app.theme.mode_title'),
          <div className="gonavi-settings-mode-grid" role="radiogroup" aria-label={t('app.theme.mode_title')}>
              {([
                  { key: 'light' as const, label: t('app.theme.mode.light.label'), preview: 'light' as const },
                  { key: 'dark' as const, label: t('app.theme.mode.dark.label'), preview: 'dark' as const },
                  { key: 'system' as const, label: t('app.theme.mode.system.label'), preview: 'system' as const },
              ]).map((item, itemIndex, themeItems) => {
                  const active = effectiveThemePreference === item.key;
                  return (
                      <button
                          key={item.key}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          tabIndex={effectiveThemePreference === item.key ? 0 : -1}
                          className={`gonavi-settings-mode-tile${active ? ' is-active' : ''}`}
                          onClick={() => selectPresetTheme(item.key)}
                          onKeyDown={(event) => {
                              if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                                  return;
                              }
                              event.preventDefault();
                              const nextIndex = event.key === 'Home'
                                  ? 0
                                  : event.key === 'End'
                                      ? themeItems.length - 1
                                      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                                          ? (itemIndex + 1) % themeItems.length
                                          : (itemIndex - 1 + themeItems.length) % themeItems.length;
                              selectPresetTheme(themeItems[nextIndex].key);
                              const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
                              radios?.[nextIndex]?.focus();
                          }}
                      >
                          {renderThemeModePreview(item.preview)}
                          <div className="gonavi-settings-mode-meta">
                              <span className="gonavi-settings-mode-label">{item.label}</span>
                              {active ? <CheckOutlined className="gonavi-settings-mode-check" /> : null}
                          </div>
                      </button>
                  );
              })}
          </div>,
      )}
      {renderThemeSettingsSection(
          t('app.theme.custom.title'),
          <CustomThemeManager />,
      )}
      {renderThemeSettingsSection(
          t('app.theme.toolbar_buttons.title'),
          <ToolbarButtonAppearanceSettings />,
          t('app.theme.toolbar_buttons.description'),
      )}
      {renderThemeSettingsSection(
          t('app.theme.titlebar_actions_placement.title'),
          <TitlebarActionsPlacementSettings />,
          t('app.theme.titlebar_actions_placement.hint'),
      )}
      {renderThemeSettingsSection(
          t('app.theme.sidebar_actions_placement.title'),
          <SidebarActionsPlacementSettings />,
          t('app.theme.sidebar_actions_placement.hint'),
      )}
      {renderThemeSettingsSection(
          t('app.theme.ui_version.sidebar_search.title'),
          <SidebarSearchModeSettings />,
          t('app.theme.ui_version.sidebar_search.hint'),
      )}
  </div>
);
