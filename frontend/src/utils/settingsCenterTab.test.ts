import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentLanguage, t } from '../i18n';
import {
  buildSettingsCenterWorkbenchTab,
  SETTINGS_CENTER_WORKBENCH_TAB_ID,
} from './settingsCenterTab';

describe('settingsCenterTab', () => {
  afterEach(() => setCurrentLanguage('zh-CN'));

  it('builds one global settings-center workbench tab with a stable id/type', () => {
    expect(buildSettingsCenterWorkbenchTab()).toEqual({
      id: SETTINGS_CENTER_WORKBENCH_TAB_ID,
      title: t('app.settings.title'),
      type: 'settings-center',
      connectionId: '',
    });
  });

  it('localizes the workbench tab title', () => {
    setCurrentLanguage('en-US');
    expect(buildSettingsCenterWorkbenchTab().title).toBe(t('app.settings.title'));
  });
});
