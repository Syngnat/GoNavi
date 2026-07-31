import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/provider';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import SecurityUpdateIntroModal from './SecurityUpdateIntroModal';

vi.mock('../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  return {
    Button: ({
      children,
    }: {
      children?: React.ReactNode;
    }) => React.createElement('button', null, children),
    Modal: ({
      children,
      footer,
      open,
      title,
    }: {
      children?: React.ReactNode;
      footer?: React.ReactNode;
      open?: boolean;
      title?: React.ReactNode;
    }) => (open ? React.createElement('section', null, title, footer, children) : null),
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  return {
    SafetyCertificateOutlined: () => React.createElement('span', null, 'certificate'),
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

const renderIntroModalText = async () => {
  let renderer: ReturnType<typeof create>;

  await act(async () => {
    renderer = create(
      <I18nProvider
        preference="en-US"
        systemLanguages={['en-US']}
        onPreferenceChange={() => undefined}
      >
        <SecurityUpdateIntroModal
          open
          darkMode={false}
          overlayTheme={overlayTheme}
          onStart={() => undefined}
          onPostpone={() => undefined}
          onViewDetails={() => undefined}
        />
      </I18nProvider>,
    );
  });

  return JSON.stringify(renderer!.toJSON());
};

describe('SecurityUpdateIntroModal i18n source guards', () => {

  it('localizes the intro modal chrome in English', async () => {
    const modalText = await renderIntroModalText();
    expect(modalText).toContain('Saved Configuration Security Update');
    expect(modalText).toContain('Complete a local configuration update before using the new secure storage.');
    expect(modalText).toContain('View Details');
    expect(modalText).toContain('Remind Me Later');
    expect(modalText).toContain('Update Now');
    expect(modalText).toContain('To move saved connections, proxy settings, and related service configuration to the new secure storage');
  });
});
