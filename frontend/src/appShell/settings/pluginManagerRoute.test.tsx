import { describe, expect, it, vi } from 'vitest';
import { buildToolCenterGroups } from './toolCenterGroups';
import type { BuildToolCenterGroupsInput } from './toolCenterGroups';
import { SETTINGS_CENTER_MENU_CATALOG } from '../../components/settings/settingsCenterMenuCatalog';
import { SETTINGS_WORKBENCH_TAB_BUILDERS } from '../../components/settings/settingsCenterNavigationTargets';
import { buildTitlebarTrailingActions } from '../../components/sidebar/titlebarTrailingActions';
import { t } from '../../i18n';
import { buildPluginManagerWorkbenchTab, PLUGIN_MANAGER_WORKBENCH_TAB_ID } from '../../utils/pluginManagerTab';

const baseInput: BuildToolCenterGroupsInput = {
  t: (key: string) => key,
  handleOpenToolCenterPane: vi.fn(),
  securityUpdateEntryVisibility: { showDetailEntry: false, showIntro: false, showBanner: false },
  securityUpdateHasLegacySensitiveItems: false,
  securityUpdateStatusMeta: { label: '', description: '', tone: 'default' },
};

describe('appShell plugin settings entry', () => {
  it('keeps 插件 out of the settings-center tree and menu catalog', () => {
    const groups = buildToolCenterGroups(baseInput).toolCenterGroups;
    expect(groups.map((group) => group.key)).toEqual(['config']);
    expect(groups[0].items.map((item) => item.key)).toEqual(['data-root', 'security-update']);

    expect(
      SETTINGS_CENTER_MENU_CATALOG.filter((node) => node.titleKey === 'plugin.manager.title'),
    ).toEqual([]);
  });

  it('opens the plugin manager as its own workbench tab from the titlebar action', () => {
    const onOpenSettingsNavigation = vi.fn();
    const plugins = buildTitlebarTrailingActions({
      t: (key: string) => key,
      onOpenSettingsNavigation,
      hideAbout: true,
      hideDrivers: true,
    }).find((action) => action.key === 'plugins');

    expect(plugins?.label).toBe('plugin.manager.title');
    plugins?.onClick?.();
    expect(onOpenSettingsNavigation).toHaveBeenCalledWith({ group: 'workspace', action: 'plugins' });

    // 处理器按 action 分发到工作台 Tab 构建器，先关设置中心再开独立 Tab。
    expect(SETTINGS_WORKBENCH_TAB_BUILDERS.plugins).toBeDefined();
    expect(SETTINGS_WORKBENCH_TAB_BUILDERS.plugins!()).toEqual({
      id: PLUGIN_MANAGER_WORKBENCH_TAB_ID,
      title: t('plugin.manager.title'),
      type: 'plugin-manager',
      connectionId: '',
    });
  });

  it('lights the titlebar entry only while the plugin manager tab is active', () => {
    const build = (pluginManagerTabActive?: boolean) => buildTitlebarTrailingActions({
      t: (key: string) => key,
      hideAbout: true,
      hideDrivers: true,
      pluginManagerTabActive,
    }).find((action) => action.key === 'plugins')!;

    expect(build(true).active).toBe(true);
    expect(build(false).active).toBe(false);
    expect(build().active).toBe(false);
    expect(buildPluginManagerWorkbenchTab().type).toBe('plugin-manager');
  });
});
