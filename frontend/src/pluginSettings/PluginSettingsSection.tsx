import { Button, Empty, Spin } from 'antd';
import { useStore } from '../store';
import { useI18n } from '../i18n/provider';
import { buildPluginManagerWorkbenchTab } from '../utils/pluginManagerTab';
import { PluginPageHost } from '../pluginPages/PluginPageHost';
import type { PluginSettingsSection as PluginSettingsSectionContribution } from '../plugins/types';
import { usePluginSettingsSection } from './usePluginSettingsSection';

/**
 * Host-owned settings slot. The title and position belong to the settings center;
 * the plugin only supplies the content, so the entry stays identical whether the
 * plugin is installed, disabled or absent (the absent case shows the install hint).
 */
export function PluginSettingsSection({ slot }: { slot: PluginSettingsSectionContribution['slot'] }) {
  const { t } = useI18n();
  const { target, loading } = usePluginSettingsSection(slot);

  if (loading) {
    return <div aria-busy="true" style={{ padding: 12 }}><Spin size="small" /></div>;
  }
  if (!target) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('app.theme.background.plugin.missing')}
      >
        <Button onClick={() => { useStore.getState().addTab(buildPluginManagerWorkbenchTab()); }}>
          {t('app.theme.background.plugin.install')}
        </Button>
      </Empty>
    );
  }
  return (
    <div
      data-plugin-settings-slot={slot}
      data-plugin-id={target.pluginID}
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      <PluginPageHost pluginID={target.pluginID} pageID={target.pageID} autoHeight />
    </div>
  );
}
