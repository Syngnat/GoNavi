import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AIProviderLogo, PRESET_ICON_SLUG } from './AIProviderLogo';

describe('AIProviderLogo', () => {
  it('maps known presets to brand SVG paths', () => {
    expect(PRESET_ICON_SLUG.openai).toBe('openai');
    expect(PRESET_ICON_SLUG.codex).toBeUndefined();
    expect(PRESET_ICON_SLUG['claude-subscription']).toBe('claudecode');
    expect(PRESET_ICON_SLUG['qwen-bailian']).toBe('alibabacloud');
    expect(PRESET_ICON_SLUG.atlascloud).toBe('atlascloud');
    expect(PRESET_ICON_SLUG.orcarouter).toBe('orcarouter');
    expect(PRESET_ICON_SLUG.zhipu).toBe('zhipu');
    expect(PRESET_ICON_SLUG.moonshot).toBe('moonshot');
    expect(PRESET_ICON_SLUG['xiaomi-mimo']).toBe('xiaomimimo');
    expect(PRESET_ICON_SLUG['volcengine-ark']).toBe('volcengine');
    expect(PRESET_ICON_SLUG['volcengine-coding']).toBe('volcengine');
    const markup = renderToStaticMarkup(<AIProviderLogo presetKey="openai" label="OpenAI" />);
    expect(markup).toContain('/icons/ai/openai.svg');
    const xiaomiMiMo = renderToStaticMarkup(<AIProviderLogo presetKey="xiaomi-mimo" label="Xiaomi MiMo" />);
    expect(xiaomiMiMo).toContain('/icons/ai/xiaomimimo.svg');
  });

  it('falls back to the first letter when there is no asset', () => {
    const markup = renderToStaticMarkup(<AIProviderLogo presetKey="unknown-provider" label="Kimi" />);
    expect(markup).toContain('is-fallback');
    expect(markup).toContain('K');
    expect(markup).not.toContain('/icons/ai/');
  });

  it('adapts the monochrome Atlas mark in dark mode without recoloring Kimi', () => {
    const atlas = renderToStaticMarkup(<AIProviderLogo presetKey="atlascloud" label="Atlas Cloud" dark />);
    const kimi = renderToStaticMarkup(<AIProviderLogo presetKey="moonshot" label="Kimi" dark />);
    expect(atlas).toContain('filter:invert(1)');
    expect(kimi).not.toContain('filter:invert(1)');
  });

  it('uses a dedicated monochrome Xiaomi MiMo glyph that stays legible at provider-list size', () => {
    const logo = readFileSync(new URL('../../../public/icons/ai/xiaomimimo.svg', import.meta.url), 'utf8');

    expect(logo).toContain('<title>Xiaomi MiMo</title>');
    expect(logo).toContain('viewBox="0 0 24 24"');
    expect(logo).toContain('fill="currentColor"');
    expect(logo).not.toContain('<image');
    expect(logo).not.toContain('data:image');
    expect(logo).not.toContain('#FF6900');
    expect(logo.match(/<path\b/g)).toHaveLength(3);
  });
});
