import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import { V2TableContextMenuView } from './V2TableContextMenu';

const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const;
const catalogs = Object.fromEntries(locales.map((locale) => [
  locale,
  JSON.parse(readFileSync(new URL(`../../../shared/i18n/${locale}.json`, import.meta.url), 'utf8')) as Record<string, string>,
])) as Record<typeof locales[number], Record<string, string>>;

const placeholders = (value: string): string[] => [...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
  .map((match) => match[1])
  .sort();

const requiredKeys = [
  'connection.backend.action.copy_table',
  'db.backend.error.table_copy_unsupported',
  'db.backend.error.table_copy_list_failed',
  'db.backend.error.table_copy_create_failed',
  'db.backend.error.table_copy_data_failed',
  'db.backend.error.table_copy_cleanup_failed',
  'db.backend.error.table_copy_unsafe_storage',
  'db.backend.message.table_copied',
  'table_copy.action.label',
  'table_copy.message.backend_unavailable',
  'table_copy.message.failed',
  'table_copy.message.loading',
  'table_copy.message.refresh_failed',
  'table_copy.message.success',
  'table_copy.message.target_missing',
  'table_copy.message.unsupported',
  'table_copy.modal.content',
  'table_copy.modal.title',
] as const;

describe('whole-table copy i18n and action wiring', () => {
  it('keeps frontend and backend copy feedback localized with matching placeholders', () => {
    requiredKeys.forEach((key) => {
      const expected = placeholders(catalogs['zh-CN'][key]);
      locales.forEach((locale) => {
        expect(placeholders(catalogs[locale][key]), `${locale}:${key}`).toEqual(expected);
      });
    });
  });

  it('shows whole-table copy in the shared v2 copy group only when supported', () => {
    setCurrentLanguage('zh-CN');

    const supported = renderToStaticMarkup(
      <V2TableContextMenuView tableName="orders" supportsCopyTable />,
    );
    const unsupported = renderToStaticMarkup(
      <V2TableContextMenuView tableName="orders" supportsCopyTable={false} />,
    );

    expect(supported).toContain('复制整表');
    expect(unsupported).not.toContain('复制整表');
  });
});
