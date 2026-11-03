import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import SettingsPills, { type PillOption } from '../../components/settings/SettingsPills';
import {
  sanitizeTabAppearanceStyle,
  sanitizeTabCloseButtonPosition,
  TAB_APPEARANCE_STYLE_LABEL_KEYS,
  TAB_APPEARANCE_STYLES,
  TAB_CLOSE_BUTTON_POSITION_LABEL_KEYS,
  TAB_CLOSE_BUTTON_POSITIONS,
  type TabAppearanceStyle,
  type TabCloseButtonPosition,
} from '../../utils/tabAppearance';

// 标签外观区块：直接读写 appearance，不新增外层 props。
export const TabAppearanceSettingsSection = () => {
  const { t } = useI18n();
  const appearance = useStore((state) => state.appearance);
  const setAppearance = useStore((state) => state.setAppearance);
  // 旧配置或脏数据回退默认值，避免分段控件没有选中项。
  const style = sanitizeTabAppearanceStyle(appearance.tabAppearanceStyle);
  const closePosition = sanitizeTabCloseButtonPosition(appearance.tabCloseButtonPosition);
  const styleOptions: PillOption<TabAppearanceStyle>[] = TAB_APPEARANCE_STYLES.map((value) => ({
    value,
    label: t(TAB_APPEARANCE_STYLE_LABEL_KEYS[value]),
  }));
  const closePositionOptions: PillOption<TabCloseButtonPosition>[] = TAB_CLOSE_BUTTON_POSITIONS.map((value) => ({
    value,
    label: t(TAB_CLOSE_BUTTON_POSITION_LABEL_KEYS[value]),
  }));

  return (
    <section className="gonavi-settings-section" data-tab-appearance-settings="true">
      <div className="gonavi-settings-section-title">{t('app.theme.tab_appearance.title')}</div>
      <div className="gonavi-settings-section-hint">{t('app.theme.tab_appearance.description')}</div>
      <div className="gonavi-settings-row is-stacked">
        <div>
          <div className="gonavi-settings-label">{t('app.theme.tab_appearance.style.label')}</div>
          <div className="gonavi-settings-label-hint">{t('app.theme.tab_appearance.style.hint')}</div>
        </div>
        <div className="gonavi-settings-control">
          <SettingsPills
            ariaLabel={t('app.theme.tab_appearance.style.label')}
            dataAttribute="data-tab-appearance-style"
            options={styleOptions}
            value={style}
            onChange={(nextStyle) => setAppearance({ tabAppearanceStyle: nextStyle })}
          />
        </div>
      </div>
      <div className="gonavi-settings-row is-stacked">
        <div>
          <div className="gonavi-settings-label">{t('app.theme.tab_appearance.close_position.label')}</div>
          <div className="gonavi-settings-label-hint">{t('app.theme.tab_appearance.close_position.hint')}</div>
        </div>
        <div className="gonavi-settings-control">
          <SettingsPills
            ariaLabel={t('app.theme.tab_appearance.close_position.label')}
            dataAttribute="data-tab-close-position"
            options={closePositionOptions}
            value={closePosition}
            onChange={(nextPosition) => setAppearance({ tabCloseButtonPosition: nextPosition })}
          />
        </div>
      </div>
    </section>
  );
};
