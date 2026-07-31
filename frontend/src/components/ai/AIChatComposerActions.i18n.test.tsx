import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import AIChatComposerActions from './AIChatComposerActions';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  return {
    Button: ({
      icon,
      onClick,
      children,
      ...rest
    }: {
      icon?: React.ReactNode;
      onClick?: () => void;
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => React.createElement('button', { ...rest, onClick }, icon, children),
    Tooltip: ({
      title,
      children,
    }: {
      title?: React.ReactNode;
      children?: React.ReactNode;
    }) => React.createElement(
      'div',
      { 'data-tooltip-title': typeof title === 'string' ? title : undefined },
      children,
    ),
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const makeIcon = (name: string) => () => React.createElement('span', { 'data-icon': name });
  return {
    CodeOutlined: makeIcon('code'),
    PictureOutlined: makeIcon('picture'),
    SendOutlined: makeIcon('send'),
    StopOutlined: makeIcon('stop'),
    TableOutlined: makeIcon('table'),
  };
});

const overlayTheme: OverlayWorkbenchTheme = {
  isDark: false,
  shellBg: '#fff',
  shellBorder: '1px solid #eee',
  shellShadow: 'none',
  shellBackdropFilter: 'none',
  sectionBg: '#fff',
  sectionBorder: '1px solid #eee',
  mutedText: '#666',
  titleText: '#111',
  iconBg: '#f5f5f5',
  iconColor: '#1677ff',
  hoverBg: '#f5f5f5',
  selectedBg: '#e6f4ff',
  selectedText: '#1677ff',
  divider: '#eee',
};

const baseProps = {
  variant: 'legacy' as const,
  input: 'select 1',
  draftAttachmentCount: 0,
  sending: false,
  darkMode: false,
  textColor: '#111',
  mutedColor: '#666',
  overlayTheme,
  fileInputRef: { current: null } as React.RefObject<HTMLInputElement>,
  onAttachmentUpload: () => undefined,
  onOpenContext: () => undefined,
  onOpenSlashMenu: () => undefined,
  onSend: () => undefined,
  onStop: () => undefined,
};

const renderComposerActions = (props: Partial<React.ComponentProps<typeof AIChatComposerActions>>) => renderToStaticMarkup(
  <I18nProvider
    preference="en-US"
    systemLanguages={['en-US']}
    onPreferenceChange={() => undefined}
  >
    <AIChatComposerActions
      {...baseProps}
      {...props}
    />
  </I18nProvider>,
);

const renderComposerActionsWithoutProvider = (props: Partial<React.ComponentProps<typeof AIChatComposerActions>>) => renderToStaticMarkup(
  <AIChatComposerActions
    {...baseProps}
    {...props}
  />,
);

describe('AIChatComposerActions i18n source guards', () => {

  it('renders localized v2 tooltips and stop title in en-US', () => {
    const markup = renderComposerActions({ variant: 'v2', sending: true, input: '' });

    expect(markup).toContain('Upload attachment (images, Markdown, Word, Excel, PDF, text)');
    expect(markup).toContain('Attach database table context');
    expect(markup).toContain('Slash commands');
    expect(markup).toContain('title="Stop generating"');
  });

  it('renders localized legacy send title in en-US', () => {
    const markup = renderComposerActions({ variant: 'legacy', sending: false });

    expect(markup).toContain('Upload attachment (images, Markdown, Word, Excel, PDF, text)');
    expect(markup).toContain('Attach database table context');
    expect(markup).toContain('title="Send"');
  });

  it('falls back to English tooltips and action titles without an i18n provider', () => {
    expect(() => renderComposerActionsWithoutProvider({ variant: 'v2', sending: true, input: '' })).not.toThrow();

    const sendingMarkup = renderComposerActionsWithoutProvider({ variant: 'v2', sending: true, input: '' });
    expect(sendingMarkup).toContain('Upload attachment (images, Markdown, Word, Excel, PDF, text)');
    expect(sendingMarkup).toContain('Attach database table context');
    expect(sendingMarkup).toContain('Slash commands');
    expect(sendingMarkup).toContain('title="Stop generating"');
    expect(sendingMarkup).not.toContain('ai_chat.input.tooltip.upload_attachment');

    const idleMarkup = renderComposerActionsWithoutProvider({ variant: 'legacy', sending: false });
    expect(idleMarkup).toContain('title="Send"');
    expect(idleMarkup).not.toContain('ai_chat.input.action.send');
  });
});
