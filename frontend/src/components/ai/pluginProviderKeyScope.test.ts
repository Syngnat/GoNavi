import { describe, expect, it } from 'vitest';
import type { AccountKeyItem, ScannedModelItem } from './aiPluginProviderAccountApi';
import { modelsForKey, previewModelList, resolveProviderKeyId } from './pluginProviderKeyScope';

const keyItem = (id: string, key: string): AccountKeyItem => ({
  id, key, name: '', status: '', groupName: '', lastUsedAt: '',
});

const scanned = (id: string, keyIds: string[]): ScannedModelItem => ({ id, name: '', contextWindow: 0, keyIds });

describe('resolveProviderKeyId', () => {
  const choices = [keyItem('1', 'sk-aaaaaaaaaaaa1111'), keyItem('2', 'sk-bbbbbbbbbbbb2222')];

  it('matches the picked key by its full value', () => {
    expect(resolveProviderKeyId(choices, 'sk-bbbbbbbbbbbb2222', '')).toBe('2');
  });

  it('falls back to a unique four-character hint for a stored key', () => {
    expect(resolveProviderKeyId(choices, '', '1111')).toBe('1');
  });

  it('refuses to guess when two keys share the hint', () => {
    const ambiguous = [keyItem('1', 'sk-aaaaaaaaaaaa1111'), keyItem('3', 'sk-cccccccccccc1111')];
    expect(resolveProviderKeyId(ambiguous, '', '1111')).toBe('');
  });

  it('returns empty when nothing matches', () => {
    expect(resolveProviderKeyId(choices, '', '9999')).toBe('');
    expect(resolveProviderKeyId(choices, 'sk-unknown', '')).toBe('');
    expect(resolveProviderKeyId([], '', '1111')).toBe('');
  });
});

describe('modelsForKey', () => {
  const items = [scanned('a', ['1']), scanned('b', ['1', '2']), scanned('c', ['2']), scanned('a', ['1'])];

  it('keeps only the models that key reaches', () => {
    expect(modelsForKey(items, '1')).toEqual(['a', 'b']);
    expect(modelsForKey(items, '2')).toEqual(['b', 'c']);
  });

  it('returns nothing without a key identity', () => {
    expect(modelsForKey(items, '')).toEqual([]);
  });
});

describe('previewModelList', () => {
  it('joins short lists and truncates long ones', () => {
    expect(previewModelList(['a', 'b'])).toBe('a / b');
    expect(previewModelList(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a / b / c / d / e / f / +1');
    expect(previewModelList([])).toBe('');
  });
});
