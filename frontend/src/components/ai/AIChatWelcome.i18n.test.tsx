import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { catalogs, t } from '../../i18n/catalog';
import { I18nProvider } from '../../i18n/provider';
import { SUPPORTED_LANGUAGES } from '../../i18n/resolveLanguage';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import { AIChatWelcome } from './AIChatWelcome';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('@ant-design/icons', () => {
  const Icon = () => <span />;
  return {
    ApiOutlined: Icon,
    DatabaseOutlined: Icon,
    FileTextOutlined: Icon,
    RobotOutlined: Icon,
    ThunderboltOutlined: Icon,
  };
});

const welcomeKeys = [
  'ai_chat.welcome.title',
  'ai_chat.welcome.description.default',
  'ai_chat.welcome.description.with_context',
  'ai_chat.quick_action.table_separator',
  'ai_chat.quick_action.generate_sql',
  'ai_chat.quick_action.generate_sql.title',
  'ai_chat.quick_action.generate_sql.hint.default',
  'ai_chat.quick_action.generate_sql.hint.with_context',
  'ai_chat.quick_action.generate_sql.prompt.default',
  'ai_chat.quick_action.generate_sql.prompt.with_context',
  'ai_chat.quick_action.explain_schema',
  'ai_chat.quick_action.explain_schema.title',
  'ai_chat.quick_action.explain_schema.hint.with_context',
  'ai_chat.quick_action.explain_schema.prompt.with_context',
  'ai_chat.quick_action.explain_sql',
  'ai_chat.quick_action.explain_sql.title',
  'ai_chat.quick_action.explain_sql.hint.default',
  'ai_chat.quick_action.explain_sql.prompt.default',
  'ai_chat.quick_action.optimize',
  'ai_chat.quick_action.optimize.title',
  'ai_chat.quick_action.optimize.hint.default',
  'ai_chat.quick_action.optimize.hint.with_context',
  'ai_chat.quick_action.optimize.prompt.default',
  'ai_chat.quick_action.optimize.prompt.with_context',
  'ai_chat.quick_action.schema_analysis',
  'ai_chat.quick_action.schema_analysis.title',
  'ai_chat.quick_action.schema_analysis.hint.default',
  'ai_chat.quick_action.schema_analysis.hint.with_context',
  'ai_chat.quick_action.schema_analysis.prompt.default',
  'ai_chat.quick_action.schema_analysis.prompt.with_context',
  'ai_chat.welcome.suggestion.divider',
  'ai_chat.welcome.suggestion.low_rows.default',
  'ai_chat.welcome.suggestion.low_rows.with_context',
  'ai_chat.welcome.suggestion.channel_distribution.default',
  'ai_chat.welcome.suggestion.channel_distribution.with_context',
  'ai_chat.welcome.suggestion.cleanup.default',
  'ai_chat.welcome.suggestion.cleanup.with_context',
] as const;

type WelcomeKey = (typeof welcomeKeys)[number];

const placeholderExpectations: Partial<Record<WelcomeKey, string[]>> = {
  'ai_chat.welcome.description.with_context': ['count'],
  'ai_chat.quick_action.generate_sql.prompt.with_context': ['tables'],
  'ai_chat.quick_action.explain_schema.prompt.with_context': ['tables'],
  'ai_chat.quick_action.optimize.prompt.with_context': ['tables'],
  'ai_chat.quick_action.schema_analysis.prompt.with_context': ['tables'],
  'ai_chat.welcome.suggestion.low_rows.with_context': ['table'],
};

const valuesExpectedToDifferFromEnglish = [
  'ai_chat.welcome.description.default',
  'ai_chat.quick_action.generate_sql.title',
  'ai_chat.quick_action.explain_sql.hint.default',
  'ai_chat.welcome.suggestion.divider',
  'ai_chat.welcome.suggestion.cleanup.default',
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
    node.props?.title,
    textContent(node.children || []),
  ].filter(Boolean).join('');
};

const renderWelcome = async (
  overrides: Partial<React.ComponentProps<typeof AIChatWelcome>> = {},
  quickActionPrompts: string[] = [],
): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <I18nProvider
        preference="en-US"
        systemLanguages={['en-US']}
        onPreferenceChange={() => {}}
      >
        <AIChatWelcome
          overlayTheme={buildOverlayWorkbenchTheme(false)}
          quickActionBg="#fff"
          quickActionBorder="#d0d5dd"
          textColor="#101828"
          mutedColor="#667085"
          onQuickAction={(prompt) => quickActionPrompts.push(prompt)}
          {...overrides}
        />
      </I18nProvider>,
    );
  });
  return renderer!;
};

const findQuickActionNodes = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) =>
    typeof node.props.className === 'string'
    && node.props.className.includes('quick-action-btn')
    && typeof node.props.onClick === 'function',
  );

describe('AIChatWelcome i18n', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps welcome catalog keys complete with aligned placeholders', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = catalogs[language] as Record<string, string>;
      for (const key of welcomeKeys) {
        expect(catalog).toHaveProperty(key);
        expect(catalog[key]).toBeTruthy();
        expect(catalog[key]).not.toBe(key);
        expect(getPlaceholders(catalog[key])).toEqual(placeholderExpectations[key] ?? []);
      }
    }

    for (const language of SUPPORTED_LANGUAGES.filter((item) => item !== 'en-US')) {
      const catalog = catalogs[language] as Record<string, string>;
      for (const key of valuesExpectedToDifferFromEnglish) {
        expect(catalog[key]).not.toBe(catalogs['en-US'][key]);
      }
    }
  });

  it('renders English legacy welcome chrome and sends localized SQL prompts with raw fences', async () => {
    const quickActionPrompts: string[] = [];
    const renderer = await renderWelcome({ isV2Ui: false }, quickActionPrompts);
    const pageText = textContent(renderer.toJSON());

    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.title'));
    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.description.default'));
    expect(pageText).toContain(t('en-US', 'ai_chat.quick_action.generate_sql'));
    expect(pageText).toContain(t('en-US', 'ai_chat.quick_action.explain_sql'));
    expect(pageText).toContain(t('en-US', 'ai_chat.quick_action.optimize'));
    expect(pageText).toContain(t('en-US', 'ai_chat.quick_action.schema_analysis'));
    expect(pageText).not.toContain('你好，我是 GoNavi AI');
    expect(pageText).not.toContain('请解释以下 SQL');

    const actions = findQuickActionNodes(renderer);
    await act(async () => {
      actions[1].props.onClick();
    });

    expect(quickActionPrompts[0]).toBe(t('en-US', 'ai_chat.quick_action.explain_sql.prompt.default'));
    expect(quickActionPrompts[0]).toContain('```sql\n\n```');
    expect(quickActionPrompts[0]).not.toContain('请解释以下 SQL');
  });

  it('renders English V2 quick action labels, hints, divider, and suggestions', async () => {
    const quickActionPrompts: string[] = [];
    const renderer = await renderWelcome({ isV2Ui: true }, quickActionPrompts);
    const pageText = textContent(renderer.toJSON());

    expect(pageText).toContain(t('en-US', 'ai_chat.quick_action.generate_sql.title'));
    expect(pageText).toContain(t('en-US', 'ai_chat.quick_action.generate_sql.hint.default'));
    expect(pageText).toContain(t('en-US', 'ai_chat.quick_action.explain_sql.title'));
    expect(pageText).toContain(t('en-US', 'ai_chat.quick_action.explain_sql.hint.default'));
    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.suggestion.divider'));
    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.suggestion.low_rows.default'));
    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.suggestion.channel_distribution.default'));
    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.suggestion.cleanup.default'));
    expect(pageText).not.toContain('或直接提问');
    expect(pageText).not.toContain('自然语言生成查询');

    const actions = findQuickActionNodes(renderer);
    await act(async () => {
      actions[2].props.onClick();
    });

    expect(quickActionPrompts[0]).toBe(t('en-US', 'ai_chat.quick_action.optimize.prompt.default'));
    expect(quickActionPrompts[0]).toContain('```sql\n\n```');
  });

  it('keeps context table names raw in V2 suggestions and quick action prompts', async () => {
    const quickActionPrompts: string[] = [];
    const renderer = await renderWelcome(
      { isV2Ui: true, contextTableNames: ['public.orders', 'analytics.channel_metrics'] },
      quickActionPrompts,
    );
    const pageText = textContent(renderer.toJSON());

    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.description.with_context', { count: 2 }));
    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.suggestion.low_rows.with_context', { table: 'public.orders' }));
    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.suggestion.channel_distribution.with_context'));
    expect(pageText).toContain(t('en-US', 'ai_chat.welcome.suggestion.cleanup.with_context'));
    expect(pageText).not.toContain('orders only');

    const actions = findQuickActionNodes(renderer);
    await act(async () => {
      actions[0].props.onClick();
    });

    expect(quickActionPrompts[0]).toBe(t(
      'en-US',
      'ai_chat.quick_action.generate_sql.prompt.with_context',
      { tables: 'public.orders, analytics.channel_metrics' },
    ));
    expect(quickActionPrompts[0]).toContain('public.orders');
    expect(quickActionPrompts[0]).toContain('analytics.channel_metrics');
    expect(quickActionPrompts[0]).not.toContain('请根据以下表结构');
  });
});
