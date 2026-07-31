import { describe, expect, it } from 'vitest';

import { catalogs } from '../i18n/catalog';
import {
  MCP_AUTHORING_NOTES,
  MCP_FIELD_GUIDES,
  MCP_SERVER_FILL_STEPS,
  MCP_TROUBLESHOOTING_GUIDES,
} from './mcpServerGuidance';
const supportedLanguages = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'] as const;

const getPlaceholders = (value: string) =>
  Array.from(value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g), (match) => match[1]).sort();

describe('mcpServerGuidance', () => {
  it('keeps MCP guide copy behind i18n keys instead of hard-coded Chinese source text', () => {
    expect(MCP_SERVER_FILL_STEPS.every((item) => item.titleKey.startsWith('ai_settings.mcp_server.guide.step.'))).toBe(true);
    expect(MCP_FIELD_GUIDES.every((item) => item.titleKey.startsWith('ai_settings.mcp_server.guide.field.'))).toBe(true);
    expect(MCP_TROUBLESHOOTING_GUIDES.every((item) => item.symptomKey.startsWith('ai_settings.mcp_server.guide.troubleshooting.'))).toBe(true);
    expect(MCP_AUTHORING_NOTES.every((key) => key.startsWith('ai_settings.mcp_server.guide.note.'))).toBe(true);
  });

  it('keeps raw examples in MCP guidance metadata', () => {
    const allExamples = MCP_TROUBLESHOOTING_GUIDES
      .map((item) => item.example || '')
      .join('\n');

    expect(allExamples).toContain('command=npx');
    expect(allExamples).toContain('KEY=VALUE');
    expect(allExamples).toContain('stdio');
  });

  it('retains stable guide identities for rendering and snapshots', () => {
    expect(MCP_SERVER_FILL_STEPS.map((item) => item.key)).toEqual([
      'template',
      'name',
      'command',
      'args',
      'env-timeout',
    ]);

    expect(MCP_FIELD_GUIDES.map((item) => item.key)).toEqual([
      'name',
      'enabled',
      'transport',
      'command',
      'args',
      'env',
      'timeout',
    ]);

    expect(MCP_TROUBLESHOOTING_GUIDES.map((item) => item.key)).toEqual([
      'command-not-found',
      'timeout-or-no-tools',
      'auth-failed',
      'stdio-only',
    ]);
  });

  it('keeps MCP guide and section catalog keys available in all supported languages', () => {
    const baseCatalog = catalogs['en-US'] as Record<string, string>;
    const requiredKeys = Object.keys(baseCatalog)
      .filter((key) => key.startsWith('ai_settings.mcp_server.guide.') || key.startsWith('ai_settings.mcp_server.section.'))
      .sort();

    expect(requiredKeys.length).toBeGreaterThan(0);

    for (const language of supportedLanguages) {
      const catalog = catalogs[language] as Record<string, string>;
      for (const key of requiredKeys) {
        expect(catalog[key], `${language}:${key}`).toBeTruthy();
        expect(getPlaceholders(catalog[key]), `${language}:${key}`).toEqual(getPlaceholders(baseCatalog[key]));
      }
    }

    expect(getPlaceholders(baseCatalog['ai_settings.mcp_server.guide.full_command.placeholder'])).toEqual(['example']);
    expect(getPlaceholders(baseCatalog['ai_settings.mcp_server.guide.full_command.parsed_summary'])).toEqual([
      'argsCount',
      'command',
      'envCount',
    ]);
  });
});
