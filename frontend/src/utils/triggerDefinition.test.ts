import { describe, expect, it } from 'vitest';

import { findTriggerDefinitionStatement } from './triggerDefinition';

describe('findTriggerDefinitionStatement', () => {
  it('matches a qualified trigger name against Wails metadata case-insensitively', () => {
    expect(findTriggerDefinitionStatement([
      { name: 'TR_T_MEMCARD_REG', statement: 'CREATE OR REPLACE TRIGGER TR_T_MEMCARD_REG ...' },
    ], 'H2.tr_t_memcard_reg')).toContain('CREATE OR REPLACE TRIGGER');
  });

  it('prefers an exact quoted-name match when Oracle names differ only by case', () => {
    expect(findTriggerDefinitionStatement([
      { name: 'TR_AUDIT', statement: 'UPPERCASE_TRIGGER' },
      { name: 'tr_audit', statement: 'LOWERCASE_TRIGGER' },
    ], 'H2."tr_audit"')).toBe('LOWERCASE_TRIGGER');
  });
});
