import { useI18n } from '../../i18n/provider';
import { useStore } from '../../store';
import type { SidebarActionsPlacement } from '../../utils/titlebarActionsPlacement';
import SettingsPills from './SettingsPills';

/** 新版左侧搜索模式：命令面板 / 常驻过滤框。 */
export function SidebarSearchModeSettings() {
  const { t } = useI18n();
  const mode = useStore((state) => state.appearance.v2SidebarSearchMode ?? 'command');
  const setAppearance = useStore((state) => state.setAppearance);
  return (
    <SettingsPills
      ariaLabel={t('app.theme.ui_version.sidebar_search.title')}
      options={[
        { value: 'command', label: t('app.theme.ui_version.sidebar_search.command') },
        { value: 'filter', label: t('app.theme.ui_version.sidebar_search.filter') },
      ]}
      value={mode}
      onChange={(value) => setAppearance({ v2SidebarSearchMode: value })}
    />
  );
}

/**
 * 侧栏工具按钮（搜索 / 定位 / 回顶 / 连接操作 / 折叠）位置：
 * 默认放在顶部工具条，也可固定在连接树左侧的侧边栏里竖排。
 */
export function SidebarActionsPlacementSettings() {
  const { t } = useI18n();
  const placement = useStore((state) => state.appearance.sidebarActionsPlacement);
  const setAppearance = useStore((state) => state.setAppearance);
  return (
    <SettingsPills<SidebarActionsPlacement>
      ariaLabel={t('app.theme.sidebar_actions_placement.title')}
      dataAttribute="data-sidebar-actions-placement"
      options={[
        { value: 'toolbar', label: t('app.theme.sidebar_actions_placement.toolbar') },
        { value: 'rail', label: t('app.theme.sidebar_actions_placement.rail') },
      ]}
      value={placement}
      onChange={(value) => setAppearance({ sidebarActionsPlacement: value })}
    />
  );
}
