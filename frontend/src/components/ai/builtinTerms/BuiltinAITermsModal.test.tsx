import { readFileSync } from 'node:fs';

import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// antd's Modal renders into a portal and its components run browser-only effects; plain
// elements stand in for them, with the modal's content shown in place.
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Modal: ({ open, title, footer, children, onCancel }: any) => (
      open ? <div data-modal data-cancel={Boolean(onCancel)}>{title}{children}{footer}</div> : null
    ),
    Button: ({ children, onClick }: any) => <button type="button" onClick={onClick}>{children}</button>,
  };
});
vi.mock('@ant-design/icons', () => ({ SafetyCertificateOutlined: () => <span data-icon="shield" /> }));

import {
  BUILTIN_AI_TERMS_STORAGE_KEY,
  hasAcceptedBuiltinAITerms,
  requestBuiltinAITerms,
  resetBuiltinAITermsStore,
} from './builtinAITermsStore';
import { BUILTIN_AI_TERMS_SECTIONS, BuiltinAITermsModal } from './BuiltinAITermsModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const;
const catalog = (locale: string): Record<string, string> => JSON.parse(
  readFileSync(new URL(`../../../../../shared/i18n/${locale}.json`, import.meta.url), 'utf8'),
);

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

const termsKeys = (): string[] => [
  'ai_builtin_terms.title', 'ai_builtin_terms.intro', 'ai_builtin_terms.decline', 'ai_builtin_terms.accept',
  ...BUILTIN_AI_TERMS_SECTIONS.flatMap((section) => [
    `ai_builtin_terms.${section.key}.title`,
    ...Array.from({ length: section.points }, (_, index) => `ai_builtin_terms.${section.key}.item${index + 1}`),
  ]),
];

describe('built-in AI usage rules modal', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    resetBuiltinAITermsStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not shown until a sign-in asks for it', () => {
    const renderer = create(<BuiltinAITermsModal />);
    expect(renderer.root.findAllByProps({ 'data-modal': true })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('shows what it is for, what it must not be used for, and what is done with the data', async () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(<BuiltinAITermsModal />); });
    let answer!: Promise<boolean>;
    act(() => { answer = requestBuiltinAITerms(); });

    const sections = renderer.root.findAll((node) => node.type === 'section').map((node) => node.props['data-section']);
    expect(sections).toEqual(['scope', 'forbidden', 'data', 'notes']);
    expect(renderer.root.findAllByType('li')).toHaveLength(2 + 5 + 4 + 3);
    const buttons = renderer.root.findAllByType('button');
    expect(buttons).toHaveLength(2);

    await act(async () => { buttons[1].props.onClick(); });
    await expect(answer).resolves.toBe(true);
    expect(hasAcceptedBuiltinAITerms()).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-modal': true })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('declining stops the sign-in and is not remembered', async () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(<BuiltinAITermsModal />); });
    let answer!: Promise<boolean>;
    act(() => { answer = requestBuiltinAITerms(); });

    await act(async () => { renderer.root.findAllByType('button')[0].props.onClick(); });

    await expect(answer).resolves.toBe(false);
    expect(localStorage.getItem(BUILTIN_AI_TERMS_STORAGE_KEY)).toBeNull();
    act(() => renderer.unmount());
  });

  it('draws one prompt when the settings page and the chat panel both mount it', async () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<><BuiltinAITermsModal /><BuiltinAITermsModal /></>);
    });
    act(() => { void requestBuiltinAITerms(); });
    expect(renderer.root.findAllByProps({ 'data-modal': true })).toHaveLength(1);

    // The one that was drawing goes away (its panel closed): the other takes over.
    act(() => { renderer.update(<BuiltinAITermsModal />); });
    expect(renderer.root.findAllByProps({ 'data-modal': true })).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('has every line of the rules in all six languages', () => {
    const enUS = catalog('en-US');
    for (const locale of LOCALES) {
      const messages = catalog(locale);
      for (const key of termsKeys()) {
        expect(typeof messages[key], `${locale} is missing ${key}`).toBe('string');
        expect(messages[key].trim().length, `${locale} has an empty ${key}`).toBeGreaterThan(0);
      }
      // A translation left as the English original is a missed one (the buttons are short, so not compared).
      if (locale !== 'en-US') {
        for (const key of termsKeys().filter((candidate) => /\.(title|item\d)$|\.intro$/.test(candidate))) {
          expect(messages[key], `${locale} ${key} is still English`).not.toBe(enUS[key]);
        }
      }
    }
  });

  it('tells each language the same four things about the data', () => {
    // The facts the Gateway keeps to: nothing of the conversation stored, only usage and audit records.
    expect(catalog('zh-CN')['ai_builtin_terms.data.item3']).toContain('不保存你的提问和模型的回答');
    expect(catalog('en-US')['ai_builtin_terms.data.item3']).toContain('does not store your questions');
    expect(BUILTIN_AI_TERMS_SECTIONS.find((section) => section.key === 'data')?.points).toBe(4);
  });
});
