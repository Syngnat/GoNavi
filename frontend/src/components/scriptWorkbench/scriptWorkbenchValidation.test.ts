import { describe, expect, it } from 'vitest';
import {
  scriptAliasErrorForBinding,
  scriptAliasErrorKey,
} from './scriptWorkbenchValidation';

describe('script workbench alias validation', () => {
  it('requires non-empty unique aliases with a supported first character', () => {
    expect(scriptAliasErrorKey([{ alias: '' }])).toBe('script_workbench.settings.alias_required');
    expect(scriptAliasErrorKey([{ alias: '9prod' }])).toBe('script_workbench.settings.alias_invalid');
    expect(scriptAliasErrorKey([{ alias: 'prod' }, { alias: 'prod' }])).toBe(
      'script_workbench.settings.alias_duplicate',
    );
    expect(scriptAliasErrorKey([{ alias: 'prod' }, { alias: 'archive.v2' }])).toBeNull();
  });

  it('reports the duplicate on the conflicting row as well as on the first row', () => {
    const bindings = [{ alias: 'prod' }, { alias: 'prod' }];
    expect(scriptAliasErrorForBinding(bindings, 0)).toBe(
      'script_workbench.settings.alias_duplicate',
    );
    expect(scriptAliasErrorForBinding(bindings, 1)).toBe(
      'script_workbench.settings.alias_duplicate',
    );
  });
});
