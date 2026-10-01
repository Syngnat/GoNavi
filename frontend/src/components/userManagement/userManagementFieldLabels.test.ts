import { describe, expect, it } from 'vitest';
import optionContract from '../../../../internal/dbuser/option_contract.json';
import enUS from '../../../../shared/i18n/en-US.json';
import zhCN from '../../../../shared/i18n/zh-CN.json';
import { userManagementOptionLabel } from './userManagementFieldLabels';

const translator = (catalog: Record<string, string>) => (key: string) => catalog[key] ?? key;

describe('user management option labels', () => {
  it('covers every option id declared by the backend contract in every shipped language', () => {
    const ids = Object.keys((optionContract as { options: Record<string, string> }).options);
    expect(ids.length).toBeGreaterThan(50);
    for (const catalog of [enUS as Record<string, string>, zhCN as Record<string, string>]) {
      const missing = ids.filter((id) => {
        const label = userManagementOptionLabel(id, translator(catalog));
        return !label || label === id || label.startsWith('user_management.option.');
      });
      expect(missing).toEqual([]);
    }
  });
});
