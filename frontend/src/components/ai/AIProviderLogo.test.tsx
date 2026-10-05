import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AIProviderLogo, PRESET_ICON_SLUG } from './AIProviderLogo';

describe('AIProviderLogo', () => {
  it('maps known presets to brand SVG paths', () => {
    expect(PRESET_ICON_SLUG.openai).toBe('openai');
    expect(PRESET_ICON_SLUG.codex).toBe('openai');
    expect(PRESET_ICON_SLUG.cursor).toBe('cursor');
    expect(PRESET_ICON_SLUG.grok).toBe('grok');
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
    expect(renderToStaticMarkup(<AIProviderLogo presetKey="codex" label="codex" />)).toContain('/icons/ai/openai.svg');
    expect(renderToStaticMarkup(<AIProviderLogo presetKey="cursor" label="Cursor" />)).toContain('/icons/ai/cursor.svg');
    expect(renderToStaticMarkup(<AIProviderLogo presetKey="grok" label="Grok" />)).toContain('/icons/ai/grok.svg');
    const xiaomiMiMo = renderToStaticMarkup(<AIProviderLogo presetKey="xiaomi-mimo" label="Xiaomi MiMo" />);
    expect(xiaomiMiMo).toContain('/icons/ai/xiaomimimo.svg');
  });

  it('shows GoNavi AI with the brand icon of the app, not a letter', () => {
    const markup = renderToStaticMarkup(<AIProviderLogo presetKey="gonavi-ai" label="GoNavi AI" />);
    expect(markup).toContain('<img');
    expect(markup).toContain('/brand-fallback.svg'); // the default brand icon
    expect(markup).not.toContain('is-fallback');
    expect(markup).not.toContain('/icons/ai/');
    // Its tile is 80% of the image; it is enlarged to the footprint of the full-box marks beside it.
    expect(markup).toContain('transform:scale(1.25)');
    // A dark theme does not recolor it: the brand tile carries its own background.
    expect(renderToStaticMarkup(<AIProviderLogo presetKey="gonavi-ai" label="GoNavi AI" dark />)).not.toContain('invert');
  });

  it('draws a custom provider as a solid slider tile, like every other provider, not as a stock grid icon', () => {
    const markup = renderToStaticMarkup(<AIProviderLogo presetKey="custom" label="Custom" />);
    expect(markup).toContain('<img');
    expect(markup).toContain('/icons/ai/custom.svg');
    expect(markup).not.toContain('anticon');
    const svg = readFileSync(new URL('../../../public/icons/ai/custom.svg', import.meta.url), 'utf8');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('<title>Custom provider</title>');
    // A slate tile with white sliders: legible on light and dark panels without recoloring.
    expect(svg).toContain('fill="#6f7f9e"');
    expect(renderToStaticMarkup(<AIProviderLogo presetKey="custom" label="Custom" dark />)).not.toContain('invert');
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
