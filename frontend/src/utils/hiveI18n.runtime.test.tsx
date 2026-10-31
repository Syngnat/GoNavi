import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { t, type SupportedLanguage } from '../i18n';
import { loadAllCatalogs } from '../i18n/catalog';
import { I18nProvider, useI18n } from '../i18n/provider';
import en from '../../../shared/i18n/en-US.json';
import zhCN from '../../../shared/i18n/zh-CN.json';
import zhTW from '../../../shared/i18n/zh-TW.json';
import ja from '../../../shared/i18n/ja-JP.json';
import de from '../../../shared/i18n/de-DE.json';
import ru from '../../../shared/i18n/ru-RU.json';

// Locale side effects are irrelevant; the real catalog, t() and provider remain intact.
vi.mock('../i18n/runtime', () => ({ syncLanguageRuntime: async () => undefined }));
const catalogs: Record<SupportedLanguage, Record<string, string>> = { 'en-US': en, 'zh-CN': zhCN, 'zh-TW': zhTW, 'ja-JP': ja, 'de-DE': de, 'ru-RU': ru };
const keys = Object.keys(en).filter(key => key.startsWith('hive.') || key.startsWith('connection.modal.hive.') || key.startsWith('connection_modal.hive.')
  || key.startsWith('datasource.variant.hive.') || key.includes('.hive_'));
const canonical = (key: string) => key.replace(/^connection\.modal\./, 'connection_modal.');
const legacy = (key: string) => key.replace(/^connection_modal\./, 'connection.modal.');
const params = Object.fromEntries(keys.flatMap(key => [...en[key as keyof typeof en].matchAll(/{{([^}]+)}}/g)].map(match => [match[1], 'value-' + match[1]])));
const expected = (language: SupportedLanguage, key: string) => catalogs[language][key].replace(/{{([^}]+)}}/g, (_, name: string) => params[name]);

beforeAll(async () => { await loadAllCatalogs(); });

function Probe() {
  const i18n = useI18n();
  return <>{keys.map(key => <span key={key} data-key={key}>{i18n.t(legacy(key), params)}</span>)}</>;
}

describe('Hive translations through real runtime resolution', () => {
  for (const language of Object.keys(catalogs) as SupportedLanguage[]) {
    it('resolves every Hive canonical key and connection.modal alias in ' + language, () => {
      expect(keys.length).toBeGreaterThanOrEqual(43);
      for (const key of keys) {
        const value = expected(language, key);
        expect(t(legacy(key), params, language), key).toBe(value);
        expect(t(canonical(key), params, language), key).toBe(value);
        expect(t(legacy(key), params, language), key).not.toBe(legacy(key));
      }
    });

    it('renders every Hive message with real useI18n in ' + language, async () => {
      let renderer: ReturnType<typeof create> | undefined;
      await act(async () => { renderer = create(<I18nProvider preference={language} onPreferenceChange={() => undefined}><Probe /></I18nProvider>); });
      try {
        const spans = renderer!.root.findAllByType('span');
        expect(spans).toHaveLength(keys.length);
        for (const span of spans) expect(span.children.join(''), span.props['data-key']).toBe(expected(language, span.props['data-key']));
      } finally { act(() => renderer!.unmount()); }
    });
  }
});
