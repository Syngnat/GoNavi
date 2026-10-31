import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { buildPluginManagerWorkbenchTab, PLUGIN_MANAGER_WORKBENCH_TAB_ID } from './pluginManagerTab';

describe('pluginManagerTab', () => {
  it('builds one global plugin manager workbench tab', () => {
    expect(buildPluginManagerWorkbenchTab()).toEqual({
      id: PLUGIN_MANAGER_WORKBENCH_TAB_ID,
      title: t('plugin.manager.title'),
      type: 'plugin-manager',
      connectionId: '',
    });
  });
});
