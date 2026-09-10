import { describe, expect, it } from 'vitest';
import { applyPresetOrder, movePresetWithinGroup } from './providerPresetOrder';

const presets = ['openai', 'codex', 'grok', 'cursor-cli', 'deepseek'].map((key) => ({ key }));
const keys = (list: Array<{ key: string }>) => list.map((preset) => preset.key);

describe('providerPresetOrder', () => {
  it('keeps the default order when nothing is stored', () => {
    expect(applyPresetOrder(presets, [])).toBe(presets);
  });

  it('sorts known keys by the stored order and appends unknown presets in default order', () => {
    expect(keys(applyPresetOrder(presets, ['grok', 'openai', 'gone']))).toEqual(['grok', 'openai', 'codex', 'cursor-cli', 'deepseek']);
  });

  it('moves a preset within its group without disturbing keys outside the group', () => {
    const ordered = ['openai', 'codex', 'grok', 'cursor-cli', 'deepseek'];
    // codex and cursor-cli are hidden; only the visible ones take part.
    const visible = ['openai', 'grok', 'deepseek'];
    expect(movePresetWithinGroup(ordered, visible, 'deepseek', 'openai')).toEqual(['deepseek', 'codex', 'openai', 'cursor-cli', 'grok']);
    expect(movePresetWithinGroup(ordered, visible, 'openai', 'grok')).toEqual(['grok', 'codex', 'openai', 'cursor-cli', 'deepseek']);
  });

  it('returns the same order for a no-op or an unknown key', () => {
    const ordered = ['a', 'b', 'c'];
    expect(movePresetWithinGroup(ordered, ['a', 'b'], 'a', 'a')).toBe(ordered);
    expect(movePresetWithinGroup(ordered, ['a', 'b'], 'a', 'zzz')).toBe(ordered);
  });
});
