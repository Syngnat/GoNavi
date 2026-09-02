import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { catalogs, t } from '../../i18n/catalog';
import { I18nProvider } from '../../i18n/provider';
import { SUPPORTED_LANGUAGES } from '../../i18n/resolveLanguage';
import { AIHistoryDrawer } from './AIHistoryDrawer';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

const storeState = vi.hoisted(() => ({
  aiChatSessions: [] as Array<{ id: string; title: string; updatedAt: number; archived?: boolean }>,
  setAIActiveSessionId: vi.fn(),
  deleteAISession: vi.fn(),
}));

vi.mock('../../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;
  return {
    DeleteOutlined: Icon,
    MenuFoldOutlined: Icon,
    PlusOutlined: Icon,
    SearchOutlined: Icon,
  };
});

vi.mock('antd', () => {
  const Button = ({ children, className, icon, onClick, style }: any) => (
    <button type="button" className={className} onClick={onClick} style={style}>
      {icon}
      {children}
    </button>
  );
  const Drawer = ({ children, open }: any) => (open ? <aside>{children}</aside> : null);
  const Input = ({ onChange, placeholder, prefix, value }: any) => (
    <label>
      {prefix}
      <input value={value} onChange={onChange} placeholder={placeholder} />
    </label>
  );
  const Tooltip = ({ children, title }: any) => (
    <span data-tooltip={title}>
      {title}
      {children}
    </span>
  );

  return { Button, Drawer, Input, Tooltip };
});

const historyKeys = [
  'ai_chat.history.title',
  'ai_chat.history.tooltip.collapse',
  'ai_chat.history.action.new_chat',
  'ai_chat.history.search.placeholder',
  'ai_chat.history.empty.no_history',
  'ai_chat.history.empty.no_matches',
  'ai_chat.history.default_session_title',
  'ai_chat.history.tooltip.delete',
] as const;

const getPlaceholders = (value: string): string[] =>
  Array.from(value.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g), (match) => match[1]).sort();

const textContent = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    return node.map((item) => textContent(item)).join('');
  }
  return [
    node.props?.['aria-label'],
    node.props?.['data-tooltip'],
    node.props?.placeholder,
    textContent(node.children || []),
  ].filter(Boolean).join('');
};

const renderDrawer = async (
  overrides: Partial<React.ComponentProps<typeof AIHistoryDrawer>> = {},
): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <I18nProvider
        preference="en-US"
        systemLanguages={['en-US']}
        onPreferenceChange={() => {}}
      >
        <AIHistoryDrawer
          open
          onClose={() => {}}
          bgColor="#fff"
          darkMode={false}
          textColor="#101828"
          mutedColor="#667085"
          borderColor="#d0d5dd"
          onCreateNew={() => {}}
          onSelectSession={() => {}}
          onArchiveSession={() => {}}
          sessionId="s1"
          {...overrides}
        />
      </I18nProvider>,
    );
  });
  return renderer!;
};

describe('AIHistoryDrawer i18n', () => {
  beforeEach(() => {
    storeState.aiChatSessions = [];
    storeState.setAIActiveSessionId.mockReset();
    storeState.deleteAISession.mockReset();
  });

  it('keeps drawer catalog keys complete with aligned placeholders', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = catalogs[language] as Record<string, string>;
      for (const key of historyKeys) {
        expect(catalog).toHaveProperty(key);
        expect(catalog[key]).toBeTruthy();
        expect(catalog[key]).not.toBe(key);
        expect(getPlaceholders(catalog[key])).toEqual([]);
      }
    }

    expect(t('en-US', 'ai_chat.history.title')).toBe('Chat history');
    expect(t('en-US', 'ai_chat.history.tooltip.collapse')).toBe('Collapse');
    expect(t('en-US', 'ai_chat.history.action.new_chat')).toBe('Start new chat');
    expect(t('en-US', 'ai_chat.history.search.placeholder')).toBe('Search history...');
    expect(t('en-US', 'ai_chat.history.empty.no_history')).toBe('No history yet');
    expect(t('en-US', 'ai_chat.history.empty.no_matches')).toBe('No matching chats');
    expect(t('en-US', 'ai_chat.history.default_session_title')).toBe('New chat');
    expect(t('en-US', 'ai_chat.history.tooltip.delete')).toBe('Delete');
  });

  it('uses distinct empty-state copy for no history versus filtered no-match results', async () => {
    const renderer = await renderDrawer();
    let pageText = textContent(renderer.toJSON());

    expect(pageText).toContain('No history yet');
    expect(pageText).not.toContain('No matching chats');

    storeState.aiChatSessions = [
      { id: 's1', title: 'prod/main.orders', updatedAt: Date.UTC(2026, 5, 13, 9, 30) },
    ];

    await act(async () => {
      renderer.update(
        <I18nProvider
          preference="en-US"
          systemLanguages={['en-US']}
          onPreferenceChange={() => {}}
        >
          <AIHistoryDrawer
            open
            onClose={() => {}}
            bgColor="#fff"
            darkMode={false}
            textColor="#101828"
            mutedColor="#667085"
            borderColor="#d0d5dd"
            onCreateNew={() => {}}
            onSelectSession={() => {}}
            onArchiveSession={() => {}}
            sessionId="s1"
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      renderer.root.findByType('input').props.onChange({ target: { value: 'does-not-match' } });
    });

    pageText = textContent(renderer.toJSON());
    expect(pageText).toContain('No matching chats');
    expect(pageText).not.toContain('No history yet');
  });

  it('renders English drawer chrome while preserving raw session titles and localized fallback titles', async () => {
    storeState.aiChatSessions = [
      { id: 's1', title: 'prod/main.orders', updatedAt: Date.UTC(2026, 5, 13, 9, 30) },
      { id: 's2', title: '', updatedAt: Date.UTC(2026, 5, 12, 8, 15) },
    ];

    const renderer = await renderDrawer();
    let pageText = textContent(renderer.toJSON());

    expect(pageText).toContain('Chat history');
    expect(pageText).toContain('Collapse');
    expect(pageText).toContain('Start new chat');
    expect(pageText).toContain('Search history...');
    expect(pageText).toContain('Delete');
    expect(pageText).toContain('prod/main.orders');
    expect(pageText).toContain('New chat');
    expect(pageText).not.toContain('对话历史');
    expect(pageText).not.toContain('开启新对话');
    expect(pageText).not.toContain('新对话');

    await act(async () => {
      renderer.root.findByType('input').props.onChange({ target: { value: 'does-not-match' } });
    });

    pageText = textContent(renderer.toJSON());
    expect(pageText).toContain('No matching chats');
    expect(pageText).not.toContain('暂无匹配的对话记录');
  });

  it('searches raw session titles only without matching localized fallback titles', async () => {
    storeState.aiChatSessions = [
      { id: 's1', title: 'prod/main.orders', updatedAt: Date.UTC(2026, 5, 13, 9, 30) },
      { id: 's2', title: '', updatedAt: Date.UTC(2026, 5, 12, 8, 15) },
    ];

    const renderer = await renderDrawer();

    await act(async () => {
      renderer.root.findByType('input').props.onChange({ target: { value: 'prod' } });
    });

    let pageText = textContent(renderer.toJSON());
    expect(pageText).toContain('prod/main.orders');
    expect(pageText).not.toContain('New chat');
    expect(pageText).not.toContain('No matching chats');

    await act(async () => {
      renderer.root.findByType('input').props.onChange({ target: { value: 'new' } });
    });

    pageText = textContent(renderer.toJSON());
    expect(pageText).toContain('No matching chats');
    expect(pageText).not.toContain('prod/main.orders');
    expect(pageText).not.toContain('New chat');
  });
});
