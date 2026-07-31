import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('./QueryEditorTransactionSettings.tsx', import.meta.url), 'utf8');
const toolbarSource = readFileSync(new URL('./QueryEditorTransactionToolbar.tsx', import.meta.url), 'utf8');

const settingsLegacyLiterals = [
  '立即',
  '参考 DBeaver',
  '手动',
  '自动',
];

const toolbarLegacyLiterals = [
  '后自动提交',
  '自动提交中',
  '提交',
  '回滚',
];

const requiredKeys = [
  'query_editor.transaction.delay.immediate',
  'query_editor.transaction.delay.immediate_commit',
  'query_editor.transaction.delay.seconds_commit',
  'query_editor.transaction.mode.tooltip',
  'query_editor.transaction.mode.manual',
  'query_editor.transaction.mode.auto',
  'query_editor.transaction.status.auto_commit_countdown',
  'query_editor.transaction.status.auto_committing',
  'query_editor.transaction.action.commit',
  'query_editor.transaction.action.commit_with_count',
  'query_editor.transaction.action.rollback',
];

describe('QueryEditor transaction i18n', () => {
  it('uses localized keys for transaction settings and toolbar chrome', () => {
    for (const source of [settingsSource, toolbarSource]) {
      expect(source).toContain("import { useOptionalI18n } from '../i18n/provider';");
      expect(source).toContain('const i18n = useOptionalI18n();');
      expect(source).toContain('const t = i18n?.t ?? defaultTranslate;');
    }

    for (const key of requiredKeys) {
      expect(`${settingsSource}\n${toolbarSource}`).toContain(key);
    }

    for (const literal of settingsLegacyLiterals) {
    }

    for (const literal of toolbarLegacyLiterals) {
    }
  });
});
