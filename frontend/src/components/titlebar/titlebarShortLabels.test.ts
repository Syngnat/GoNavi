import { describe, expect, it } from 'vitest';

import deDE from '../../../../shared/i18n/de-DE.json';
import enUS from '../../../../shared/i18n/en-US.json';
import jaJP from '../../../../shared/i18n/ja-JP.json';
import ruRU from '../../../../shared/i18n/ru-RU.json';
import zhCN from '../../../../shared/i18n/zh-CN.json';
import zhTW from '../../../../shared/i18n/zh-TW.json';
import { resolveTitlebarQuickActionShortLabel } from './titlebarShortLabels';

const catalogs: Record<string, Record<string, string>> = { deDE, enUS, jaJP, ruRU, zhCN, zhTW };
const INJECTED_KEYS = ['data-workflow', 'sql-tools', 'user-management', 'session-workbench', 'drivers'];

describe('resolveTitlebarQuickActionShortLabel', () => {
  it('maps every sidebar-injected entry to a short label key present in all catalogs', () => {
    for (const key of INJECTED_KEYS) {
      const labelKey = resolveTitlebarQuickActionShortLabel(key, (value) => value);
      expect(labelKey, key).toMatch(/^app\.titlebar\.short_label\./);
      for (const [language, catalog] of Object.entries(catalogs)) {
        expect(catalog[labelKey as string], `${language} ${labelKey}`).toBeTruthy();
      }
    }
  });

  it('keeps already short entries on their full label', () => {
    expect(resolveTitlebarQuickActionShortLabel('about-go-navi', (value) => value)).toBeUndefined();
    expect(resolveTitlebarQuickActionShortLabel('unknown', (value) => value)).toBeUndefined();
  });

  it('shortens the Chinese labels', () => {
    const zh = (value: string) => (zhCN as Record<string, string>)[value];
    expect(INJECTED_KEYS.map((key) => resolveTitlebarQuickActionShortLabel(key, zh)))
      .toEqual(['工作流', 'SQL', '用户', '会话', '驱动']);
  });
});
