import { describe, expect, it } from 'vitest';

import { t } from '../i18n';

const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const;

describe('data sync capability catalog', () => {
  it.each(locales)('does not expose the obsolete MySQL-to-Kingbase-only scope in %s', (locale) => {
    const plannerScope = t(
      'data_sync.alert.auto_create_planner_scope',
      undefined,
      locale,
    ).toLowerCase();
    const autoAddColumns = t(
      'data_sync.option.auto_add_columns',
      undefined,
      locale,
    ).toLowerCase();

    expect(plannerScope.includes('mysql') && plannerScope.includes('kingbase')).toBe(false);
    expect(autoAddColumns.includes('mysql') && autoAddColumns.includes('kingbase')).toBe(false);
  });

  it.each(locales)('renders the selected source and target pair in %s', (locale) => {
    const message = t(
      'data_sync.capability.full',
      { sourceType: 'mysql', targetType: 'postgres' },
      locale,
    );

    expect(message).toContain('mysql');
    expect(message).toContain('postgres');
    expect(message).not.toContain('{{sourceType}}');
    expect(message).not.toContain('{{targetType}}');
  });
});
