import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/provider';
import type { SecurityUpdateStatus } from '../types';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import SecurityUpdateSettingsModal from './SecurityUpdateSettingsModal';

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
    Empty: ({
      description,
    }: {
      description?: React.ReactNode;
    }) => React.createElement('div', null, description),
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
    Tag: ({
      children,
    }: {
      children?: React.ReactNode;
    }) => React.createElement('span', null, children),
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

const baseStatus: SecurityUpdateStatus = {
  overallStatus: 'needs_attention',
  summary: {
    total: 2,
    updated: 1,
    pending: 1,
    skipped: 0,
    failed: 0,
  },
  issues: [
    {
      id: 'issue-1',
      title: 'RAW issue title',
      message: 'RAW issue message',
      severity: 'high',
      status: 'needs_attention',
      action: 'open_connection',
    },
  ],
  backupPath: 'C:\\raw\\backup.zip',
  lastError: 'RAW system error',
};

const renderSettingsModalText = async (
  status: SecurityUpdateStatus = baseStatus,
  embedded = false,
) => {
  let renderer: ReturnType<typeof create>;

  await act(async () => {
    renderer = create(
      <I18nProvider
        preference="en-US"
        systemLanguages={['en-US']}
        onPreferenceChange={() => undefined}
      >
        <SecurityUpdateSettingsModal
          open
          embedded={embedded}
          darkMode={false}
          overlayTheme={overlayTheme}
          status={status}
          onClose={() => undefined}
          onStart={() => undefined}
          onRetry={() => undefined}
          onRestart={() => undefined}
          onIssueAction={() => undefined}
        />
      </I18nProvider>,
    );
  });

  return JSON.stringify(renderer!.toJSON());
};

describe('SecurityUpdateSettingsModal i18n source guards', () => {

  it('uses a flat, settings-only ledger layout while leaving the standalone surfaces available', async () => {
    const embeddedText = await renderSettingsModalText(baseStatus, true);

    expect(embeddedText).toContain('security-update-settings-embedded');
    expect(embeddedText).toContain('security-update-settings-section');
    expect(embeddedText).toContain('security-update-settings-summary');
    expect(embeddedText).toContain('security-update-settings-issue');
    expect(embeddedText).toContain('security-update-settings-technical-value');
    expect(embeddedText).toContain('"height":"auto"');
    expect(embeddedText).toContain('"minHeight":"100%"');
    expect(embeddedText).toContain('"flex":"1 0 auto"');
  });

  it('localizes settings chrome while preserving raw issue details, backup path and error text', async () => {
    const modalText = await renderSettingsModalText();
    expect(modalText).toContain('Security Update');
    expect(modalText).toContain('Manage the security update status and pending items for saved configurations.');
    expect(modalText).toContain('Check Again');
    expect(modalText).toContain('Restart Update');
    expect(modalText).toContain('Close');
    expect(modalText).toContain('Current status: Needs Attention');
    expect(modalText).toContain('Affected Scope');
    expect(modalText).toContain('Pending Items');
    expect(modalText).toContain('Status: Needs Attention');
    expect(modalText).toContain('Level: High Risk');
    expect(modalText).toContain('Latest Result');
    expect(modalText).toContain('Backup location: ');
    expect(modalText).toContain('Latest error: ');
    expect(modalText).toContain('RAW issue title');
    expect(modalText).toContain('RAW issue message');
    expect(modalText).toContain('C:\\\\raw\\\\backup.zip');
    expect(modalText).toContain('RAW system error');
  });

  it('localizes the empty pending state and issue default message fallback', async () => {
    const emptyText = await renderSettingsModalText({
      ...baseStatus,
      issues: [],
      backupPath: undefined,
      lastError: undefined,
    });
    expect(emptyText).toContain('No pending items');

    const fallbackText = await renderSettingsModalText({
      ...baseStatus,
      issues: [{
        id: 'issue-without-message',
        severity: 'medium',
        status: 'pending',
      }],
    });
    expect(fallbackText).toContain('This item needs more attention before the security update can be completed.');
  });
});
