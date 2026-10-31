import { describe, expect, it } from 'vitest';
import en from '../../../shared/i18n/en-US.json';
import zhCN from '../../../shared/i18n/zh-CN.json';
import zhTW from '../../../shared/i18n/zh-TW.json';
import ja from '../../../shared/i18n/ja-JP.json';
import de from '../../../shared/i18n/de-DE.json';
import ru from '../../../shared/i18n/ru-RU.json';

const catalogs: Record<string, Record<string, string>> = { en, zhCN, zhTW, ja, de, ru };
const hiveKeys = Object.keys(en).filter(key => key.startsWith('hive.') || key.startsWith('connection_modal.hive.')
  || key.startsWith('datasource.variant.hive.') || key.includes('.hive_'));
const variables = (value: string) => [...value.matchAll(/{{([^}]+)}}/g)].map(match => match[1]).sort();

describe('Hive six-language catalog', () => {
  it('contains complete localized Hive UI, sync, export and driver messages', () => {
    expect(hiveKeys.length).toBeGreaterThanOrEqual(39);
    for (const [language, catalog] of Object.entries(catalogs)) {
      for (const key of hiveKeys) {
        expect(catalog[key], language + ':' + key).toBeTruthy();
        expect(variables(catalog[key]), language + ':' + key).toEqual(variables(en[key as keyof typeof en]));
      }
    }
  });
});
