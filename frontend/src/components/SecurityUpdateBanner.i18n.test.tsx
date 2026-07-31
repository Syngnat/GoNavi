import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/provider';
import type { SecurityUpdateStatus } from '../types';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import SecurityUpdateBanner from './SecurityUpdateBanner';

vi.mock('../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  return {
    Button: ({
      children,
      icon,
    }: {
      children?: React.ReactNode;
      icon?: React.ReactNode;
    }) => React.createElement('button', null, icon, children),
  };
});

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  return {
    CloseOutlined: () => React.createElement('span', null, 'close'),
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

const baseStatus: SecurityUpdateStatus = {
  overallStatus: 'postponed',
  summary: {
    total: 0,
    updated: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
  },
  issues: [],
};

const renderBannerText = async (overallStatus: SecurityUpdateStatus['overallStatus']) => {
  let renderer: ReturnType<typeof create>;

  await act(async () => {
    renderer = create(
      <I18nProvider
        preference="en-US"
        systemLanguages={['en-US']}
        onPreferenceChange={() => undefined}
      >
        <SecurityUpdateBanner
          status={{ ...baseStatus, overallStatus }}
          darkMode={false}
          overlayTheme={overlayTheme}
          onStart={() => undefined}
          onRetry={() => undefined}
          onRestart={() => undefined}
          onOpenDetails={() => undefined}
          onDismiss={() => undefined}
        />
      </I18nProvider>,
    );
  });

  return JSON.stringify(renderer!.toJSON());
};

describe('SecurityUpdateBanner i18n source guards', () => {

  it('localizes the banner title and actions for each visible banner status', async () => {
    const postponedText = await renderBannerText('postponed');
    expect(postponedText).toContain('Saved configurations can be securely updated');
    expect(postponedText).toContain('Update Now');

    const needsAttentionText = await renderBannerText('needs_attention');
    expect(needsAttentionText).toContain('View Details');
    expect(needsAttentionText).toContain('Check Again');

    const rolledBackText = await renderBannerText('rolled_back');
    expect(rolledBackText).toContain('Restart Update');
    expect(rolledBackText).toContain('View Details');
  });
});
