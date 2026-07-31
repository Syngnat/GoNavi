import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import AIMCPCommandDraftPreview from './AIMCPCommandDraftPreview';
import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

const renderPreview = (preference: 'en-US' | 'zh-CN') => renderToStaticMarkup(
  <I18nProvider
    preference={preference}
    systemLanguages={[preference]}
    onPreferenceChange={() => undefined}
  >
    <AIMCPCommandDraftPreview
      draft={{
        command: 'python',
        args: ['-m', 'your_mcp_server', '--stdio'],
        env: {
          OPENAI_API_KEY: '***',
          HTTP_PROXY: 'http://127.0.0.1:7890',
        },
      }}
      darkMode={false}
      overlayTheme={buildOverlayWorkbenchTheme(false)}
      cardBorder="rgba(0,0,0,0.08)"
    />
  </I18nProvider>,
);

describe('AIMCPCommandDraftPreview', () => {

  it('renders localized preview chrome while preserving raw command, args, and env keys', () => {
    const enMarkup = renderPreview('en-US');
    const zhMarkup = renderPreview('zh-CN');

    expect(enMarkup).toContain('Auto split preview');
    expect(enMarkup).toContain('Environment variables');
    expect(enMarkup).toContain('Startup command');
    expect(enMarkup).toContain('Command arguments');
    expect(enMarkup).toContain('Will write 2 environment variables.');
    expect(enMarkup).toContain('Will split into 3 separate argument tags.');

    expect(zhMarkup).toContain('自动拆分预览');
    expect(zhMarkup).toContain('环境变量');
    expect(zhMarkup).toContain('启动命令');
    expect(zhMarkup).toContain('命令参数');

    for (const markup of [enMarkup, zhMarkup]) {
      expect(markup).toContain('OPENAI_API_KEY');
      expect(markup).toContain('HTTP_PROXY');
      expect(markup).toContain('python');
      expect(markup).toContain('your_mcp_server');
      expect(markup).toContain('--stdio');
    }
  });

  it('falls back to English without an i18n provider', () => {
    const markup = renderToStaticMarkup(
      <AIMCPCommandDraftPreview
        draft={{
          command: 'python',
          args: ['-m', 'your_mcp_server', '--stdio'],
          env: {
            OPENAI_API_KEY: '***',
            HTTP_PROXY: 'http://127.0.0.1:7890',
          },
        }}
        darkMode={false}
        overlayTheme={buildOverlayWorkbenchTheme(false)}
        cardBorder="rgba(0,0,0,0.08)"
      />,
    );

    expect(markup).toContain('Auto split preview');
    expect(markup).toContain('Environment variables');
    expect(markup).toContain('OPENAI_API_KEY');
    expect(markup).toContain('HTTP_PROXY');
    expect(markup).toContain('Startup command');
    expect(markup).toContain('python');
    expect(markup).toContain('Command arguments');
    expect(markup).toContain('your_mcp_server');
    expect(markup).toContain('--stdio');
  });
});
