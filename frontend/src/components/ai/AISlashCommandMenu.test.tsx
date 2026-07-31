import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import AISlashCommandMenu from './AISlashCommandMenu';
import { filterAISlashCommands } from './aiSlashCommands';

const renderWithProvider = (
  language: 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'de-DE' | 'ru-RU',
  commands = filterAISlashCommands('/'),
) => renderToStaticMarkup(
  <I18nProvider
    preference={language}
    systemLanguages={[language]}
    onPreferenceChange={() => undefined}
  >
    <AISlashCommandMenu
      visible
      commands={commands}
      darkMode={false}
      textColor="#162033"
      mutedColor="rgba(16,24,40,0.55)"
      onSelect={() => {}}
    />
  </I18nProvider>,
);

describe('AISlashCommandMenu', () => {

  it('renders an empty-state hint when the slash filter has no matches', () => {
    const markup = renderToStaticMarkup(
      <AISlashCommandMenu
        visible
        commands={[]}
        darkMode={false}
        textColor="#162033"
        mutedColor="rgba(16,24,40,0.55)"
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('data-ai-chat-slash-empty="true"');
    expect(markup).toContain('No matching slash commands');
    expect(markup).toContain('Try these common entries first to jump into SQL generation, AI health checks, or MCP diagnostics.');
    expect(markup).toContain('There are 24 slash commands available. Search by command name, description, or keyword.');
    expect(markup).toContain('/sql');
    expect(markup).toContain('/health');
    expect(markup).toContain('/mcpadd');
  });

  it('renders grouped slash command entries with localized english copy when matches exist', () => {
    const markup = renderWithProvider('en-US');

    expect(markup).toContain('/sql');
    expect(markup).toContain('📝 Generate SQL');
    expect(markup).toContain('data-ai-chat-slash-group="generate"');
    expect(markup).toContain('SQL generation');
    expect(markup).toContain('Diagnostic probes');
    expect(markup).not.toContain('No matching slash commands');
  });
});
