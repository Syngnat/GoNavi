import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/provider';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import SecurityUpdateProgressModal from './SecurityUpdateProgressModal';

vi.mock('../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  return {
    Modal: ({
      children,
      open,
    }: {
      children?: React.ReactNode;
      open?: boolean;
    }) => (open ? React.createElement('section', null, children) : null),
    Spin: () => React.createElement('span', null, 'spin'),
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

const renderProgressModalText = async (props?: { detailText?: string }) => {
  let renderer: ReturnType<typeof create>;

  await act(async () => {
    renderer = create(
      <I18nProvider
        preference="en-US"
        systemLanguages={['en-US']}
        onPreferenceChange={() => undefined}
      >
        <SecurityUpdateProgressModal
          open
          stageText="raw stage text"
          detailText={props?.detailText}
          overlayTheme={overlayTheme}
        />
      </I18nProvider>,
    );
  });

  return JSON.stringify(renderer!.toJSON());
};

describe('SecurityUpdateProgressModal i18n source guards', () => {

  it('localizes only the empty detail fallback while preserving raw stage and detail text', async () => {
    const fallbackText = await renderProgressModalText();
    expect(fallbackText).toContain('raw stage text');
    expect(fallbackText).toContain('The currently usable configuration will be kept during the update. Please wait.');

    const rawDetailText = await renderProgressModalText({ detailText: 'RAW third-party detail' });
    expect(rawDetailText).toContain('raw stage text');
    expect(rawDetailText).toContain('RAW third-party detail');
    expect(rawDetailText).not.toContain('The currently usable configuration will be kept during the update. Please wait.');
  });
});
