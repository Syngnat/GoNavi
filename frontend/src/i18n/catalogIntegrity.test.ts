import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 语言包全局完整性不变式。
 *
 * 本用例取代了此前散落在上百个组件测试中的同类断言——那些断言各自只覆盖自己前缀下的
 * 若干 key（如 sql_audit.*），本用例覆盖全部 key，且不会因组件重命名或拆分而失效。
 *
 * 分工：
 * - key 集合跨语言一致  → shared/i18n/catalog_test.go 的 TestCatalogKeysMatch（已有，不重复）
 * - 源码 t() 引用可解析  → ./keyResolution.test.ts
 * - 译文本身的完整性    → 本文件
 */

const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const;

const catalogs = Object.fromEntries(LOCALES.map((locale) => [
  locale,
  JSON.parse(readFileSync(
    fileURLToPath(new URL(`../../../shared/i18n/${locale}.json`, import.meta.url)),
    'utf8',
  )) as Record<string, string>,
])) as Record<typeof LOCALES[number], Record<string, string>>;

/** 译文中的 {{param}} 占位符；缺失或拼错会让界面直接显示原始占位符文本 */
const placeholdersOf = (value: string): string[] => Array.from(
  value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g),
  (match) => match[1],
).sort();

describe('i18n catalog integrity', () => {
  it('keeps placeholder sets identical across every locale', () => {
    const keys = Object.keys(catalogs['en-US']);
    expect(keys.length).toBeGreaterThan(8000);

    const mismatched: string[] = [];
    for (const key of keys) {
      const expected = placeholdersOf(catalogs['en-US'][key]);
      for (const locale of LOCALES) {
        const actual = placeholdersOf(catalogs[locale][key]);
        if (actual.join('|') !== expected.join('|')) {
          mismatched.push(`${locale}:${key} expected [${expected}] got [${actual}]`);
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('has no blank translation in any locale', () => {
    const blank: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        if (typeof value !== 'string' || value.trim() === '') blank.push(`${locale}:${key}`);
      }
    }

    expect(blank).toEqual([]);
  });
});
