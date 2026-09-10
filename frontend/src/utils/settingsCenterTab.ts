import { t } from '../i18n';
import type { TabData } from '../types';

export const SETTINGS_CENTER_WORKBENCH_TAB_ID = 'settings-center';

export const buildSettingsCenterWorkbenchTab = (): TabData => ({
  id: SETTINGS_CENTER_WORKBENCH_TAB_ID,
  title: t('app.settings.title'),
  type: 'settings-center',
  connectionId: '',
});
