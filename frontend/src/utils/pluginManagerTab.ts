import { t } from '../i18n';
import type { TabData } from '../types';

export const PLUGIN_MANAGER_WORKBENCH_TAB_ID = 'plugin-manager';

export const buildPluginManagerWorkbenchTab = (): TabData => ({
  id: PLUGIN_MANAGER_WORKBENCH_TAB_ID,
  title: t('plugin.manager.title'),
  type: 'plugin-manager',
  connectionId: '',
});
