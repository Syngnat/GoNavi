import { beforeEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_AI_TERMS_STORAGE_KEY,
  BUILTIN_AI_TERMS_VERSION,
  acceptBuiltinAITerms,
  declineBuiltinAITerms,
  getBuiltinAITermsPromptOpen,
  hasAcceptedBuiltinAITerms,
  readAcceptedBuiltinAITermsVersion,
  requestBuiltinAITerms,
  resetBuiltinAITermsStore,
} from './builtinAITermsStore';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

describe('built-in AI usage rules', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    resetBuiltinAITermsStore();
  });

  it('asks a person who has not accepted, and carries on only when they agree', async () => {
    const answer = requestBuiltinAITerms(storage);
    expect(getBuiltinAITermsPromptOpen()).toBe(true);

    acceptBuiltinAITerms(storage);

    await expect(answer).resolves.toBe(true);
    expect(getBuiltinAITermsPromptOpen()).toBe(false);
    expect(hasAcceptedBuiltinAITerms(storage)).toBe(true);
    expect(JSON.parse(storage.getItem(BUILTIN_AI_TERMS_STORAGE_KEY)!)).toMatchObject({ version: BUILTIN_AI_TERMS_VERSION });
  });

  it('does not remember a refusal: the next sign-in asks again', async () => {
    const first = requestBuiltinAITerms(storage);
    declineBuiltinAITerms();
    await expect(first).resolves.toBe(false);
    expect(hasAcceptedBuiltinAITerms(storage)).toBe(false);

    const second = requestBuiltinAITerms(storage);
    expect(getBuiltinAITermsPromptOpen()).toBe(true);
    acceptBuiltinAITerms(storage);
    await expect(second).resolves.toBe(true);
  });

  it('does not ask again of someone who accepted this version', async () => {
    acceptBuiltinAITerms(storage);
    await expect(requestBuiltinAITerms(storage)).resolves.toBe(true);
    expect(getBuiltinAITermsPromptOpen()).toBe(false);
  });

  it('asks again when the rules have changed since they were accepted', async () => {
    storage.setItem(BUILTIN_AI_TERMS_STORAGE_KEY, JSON.stringify({ version: BUILTIN_AI_TERMS_VERSION - 1 }));
    expect(hasAcceptedBuiltinAITerms(storage)).toBe(BUILTIN_AI_TERMS_VERSION - 1 >= BUILTIN_AI_TERMS_VERSION);
    const pending = requestBuiltinAITerms(storage);
    expect(getBuiltinAITermsPromptOpen()).toBe(true);
    declineBuiltinAITerms();
    await pending;
  });

  it('gives callers who ask while the prompt is open the same answer, and shows one prompt', async () => {
    const a = requestBuiltinAITerms(storage);
    const b = requestBuiltinAITerms(storage);
    expect(getBuiltinAITermsPromptOpen()).toBe(true);
    acceptBuiltinAITerms(storage);
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
  });

  it('reads what is stored without trusting it', () => {
    for (const stored of [null, '', 'not json', '{}', '{"version":"x"}', '{"version":-3}', '{"version":1.5}', '[]', 'null']) {
      if (stored !== null) storage.setItem(BUILTIN_AI_TERMS_STORAGE_KEY, stored);
      expect(readAcceptedBuiltinAITermsVersion(storage)).toBe(0);
    }
    expect(hasAcceptedBuiltinAITerms(null)).toBe(false);
  });

  it('still lets the person sign in when storage is unavailable or full', async () => {
    const full = new MemoryStorage();
    full.setItem = () => { throw new Error('QuotaExceededError'); };
    const answer = requestBuiltinAITerms(full);
    expect(() => acceptBuiltinAITerms(full)).not.toThrow();
    await expect(answer).resolves.toBe(true);
    // Not remembered, so the next sign-in asks again.
    expect(hasAcceptedBuiltinAITerms(full)).toBe(false);
  });
});
