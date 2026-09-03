import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { catalogs } from '../../i18n/catalog';
import { I18nProvider } from '../../i18n/provider';
import { SUPPORTED_LANGUAGES } from '../../i18n/resolveLanguage';
import AIChatPanelModeContent from './AIChatPanelModeContent';

const renderWithI18n = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <I18nProvider
      preference="en-US"
      systemLanguages={['en-US']}
      onPreferenceChange={() => {}}
    >
      {node}
    </I18nProvider>,
  );

describe('AIChatPanelModeContent', () => {
  it('renders insight cards for the automatic insights mode', () => {
    const markup = renderWithI18n(
      <AIChatPanelModeContent
        mode="insights"
        insights={[
          {
            tone: 'info',
            title: '已关联 3 张表',
            body: '当前对话会带上 orders、customers、products 的结构上下文。',
          },
          {
            tone: 'warn',
            title: '2 条最近查询失败',
            body: 'Unknown column foo',
          },
        ]}
        sessions={[]}
        activeSessionId="session-1"
        onSelectSession={() => {}}
      />,
    );

    expect(markup).toContain('gn-v2-ai-insight-card tone-info');
    expect(markup).toContain('已关联 3 张表');
    expect(markup).toContain('2 条最近查询失败');
    expect(markup).toContain('Unknown column foo');
  });

  it('keeps history fallback catalog keys available in every locale', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = catalogs[language] as Record<string, string>;
      expect(catalog['ai_chat.panel.history.empty']).toBeTruthy();
      expect(catalog['ai_chat.panel.session.default_title']).toBeTruthy();
      expect(catalog['ai_chat.panel.history.empty']).not.toBe('ai_chat.panel.history.empty');
      expect(catalog['ai_chat.panel.session.default_title']).not.toBe('ai_chat.panel.session.default_title');
    }
  });

  it('renders a localized English empty state when there is no inline history session', () => {
    const markup = renderWithI18n(
      <AIChatPanelModeContent
        mode="history"
        insights={[]}
        sessions={[]}
        activeSessionId="session-1"
        onSelectSession={() => {}}
      />,
    );

    expect(markup).toContain('gn-v2-ai-empty-note');
    expect(markup).toContain('No chat history yet');
    expect(markup).not.toContain('暂无历史会话');
  });

  it('marks the active inline history session and localizes only the empty-title fallback', () => {
    const markup = renderWithI18n(
      <AIChatPanelModeContent
        mode="history"
        insights={[]}
        sessions={[
          { id: 'session-1', title: 'Current session', updatedAt: 1710000000000 },
          { id: 'session-2', title: '', updatedAt: 1700000000000 },
        ]}
        activeSessionId="session-1"
        onSelectSession={() => {}}
        onArchiveSession={() => {}}
      />,
    );

    expect(markup).toContain('gn-v2-ai-history-card is-active');
    expect(markup).toContain('Current session');
    expect(markup).toContain('New chat');
    expect(markup).not.toContain('新对话');
    expect(markup).toContain('aria-label="Delete"');
    expect(markup).toContain('gn-v2-ai-history-delete');
  });

  it('disables history session switches while a response is streaming', () => {
    const markup = renderWithI18n(
      <AIChatPanelModeContent
        mode="history"
        insights={[]}
        sessions={[{ id: 'session-2', title: 'Another session', updatedAt: 1710000000000 }]}
        activeSessionId="session-1"
        sessionActionsDisabled
        onSelectSession={() => {}}
      />,
    );

    expect(markup).toContain('disabled=""');
  });
});
