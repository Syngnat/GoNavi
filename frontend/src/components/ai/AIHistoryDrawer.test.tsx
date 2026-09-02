import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Drawer: ({ children }: { children?: React.ReactNode }) => <div data-testid="mock-drawer">{children}</div>,
  };
});

import { AIHistoryDrawer } from './AIHistoryDrawer';

const setAIActiveSessionId = vi.fn();
const deleteAISession = vi.fn();

let mockState = {
  aiChatSessions: [] as Array<{ id: string; title: string; updatedAt: number; archived?: boolean }>,
  setAIActiveSessionId,
  deleteAISession,
};

vi.mock('../../store', () => ({
  useStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

const renderHistoryDrawer = () => renderToStaticMarkup(
  <AIHistoryDrawer
    open
    onClose={() => {}}
    bgColor="#ffffff"
    darkMode={false}
    textColor="#162033"
    mutedColor="rgba(16,24,40,0.55)"
    borderColor="rgba(0,0,0,0.12)"
    onCreateNew={() => {}}
    onSelectSession={() => {}}
    onArchiveSession={() => {}}
    sessionId="current-session"
  />
);

describe('AIHistoryDrawer', () => {
  beforeEach(() => {
    setAIActiveSessionId.mockReset();
    deleteAISession.mockReset();
    mockState = {
      aiChatSessions: [],
      setAIActiveSessionId,
      deleteAISession,
    };
  });

  it('renders recent sessions before older sessions', () => {
    mockState = {
      ...mockState,
      aiChatSessions: [
        { id: 'older-session', title: '较早会话', updatedAt: 1710000000000 },
        { id: 'newer-session', title: '较新会话', updatedAt: 1720000000000 },
      ],
    };

    const markup = renderHistoryDrawer();

    expect(markup.indexOf('较新会话')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('较早会话')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('较新会话')).toBeLessThan(markup.indexOf('较早会话'));
  });

  it('does not render an archived session from a stale local projection', () => {
    mockState = {
      ...mockState,
      aiChatSessions: [
        { id: 'archived-session', title: 'Archived conversation', updatedAt: 1730000000000, archived: true },
        { id: 'visible-session', title: 'Visible conversation', updatedAt: 1720000000000 },
      ],
    };

    const markup = renderHistoryDrawer();

    expect(markup).toContain('Visible conversation');
    expect(markup).not.toContain('Archived conversation');
  });

  it('falls back to English drawer chrome and empty state when no i18n provider is mounted', () => {
    const markup = renderHistoryDrawer();

    expect(markup).toContain('Chat history');
    expect(markup).toContain('Start new chat');
    expect(markup).toContain('Search history...');
    expect(markup).toContain('No history yet');
    expect(markup).not.toContain('ai_chat.history.title');
    expect(markup).not.toContain('还没有历史对话');
  });

  it('disables session-changing actions while a response is streaming', () => {
    mockState = {
      ...mockState,
      aiChatSessions: [{ id: 'session-2', title: 'Another session', updatedAt: 1720000000000 }],
    };
    const markup = renderToStaticMarkup(
      <AIHistoryDrawer
        open
        onClose={() => {}}
        darkMode={false}
        textColor="#162033"
        mutedColor="#526075"
        borderColor="#d0d5dd"
        onCreateNew={() => {}}
        onSelectSession={() => {}}
        onArchiveSession={() => {}}
        disabled
        sessionId="current-session"
      />,
    );

    expect(markup).toContain('aria-disabled="true"');
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps session navigation available while mutation actions remain disabled', () => {
    mockState = {
      ...mockState,
      aiChatSessions: [{ id: 'session-2', title: 'Queued session', updatedAt: 1720000000000 }],
    };
    const markup = renderToStaticMarkup(
      <AIHistoryDrawer
        open
        onClose={() => {}}
        darkMode={false}
        textColor="#162033"
        mutedColor="#526075"
        borderColor="#d0d5dd"
        onCreateNew={() => {}}
        onSelectSession={() => {}}
        onArchiveSession={() => {}}
        disabled
        navigationDisabled={false}
        sessionId="current-session"
      />,
    );

    expect(markup).toContain('aria-disabled="false"');
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
