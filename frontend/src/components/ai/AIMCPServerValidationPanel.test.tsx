import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type { MCPServerDraftValidation } from '../../utils/mcpServerValidation';
import AIMCPServerValidationPanel from './AIMCPServerValidationPanel';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

const buildValidation = (patch: Partial<MCPServerDraftValidation> = {}): MCPServerDraftValidation => ({
  issues: [
    {
      key: 'command-missing',
      severity: 'error',
      title: '启动命令未填写',
      detail: '至少填写 node、uvx、python 或本机 exe 路径；脚本名和 --stdio 放到命令参数里。',
    },
  ],
  errorCount: 1,
  warningCount: 0,
  infoCount: 0,
  canTest: false,
  canSave: false,
  ...patch,
});

const renderPanel = (validation: MCPServerDraftValidation, preference?: 'en-US' | 'zh-CN') => {
  const panel = (
    <AIMCPServerValidationPanel
      validation={validation}
      cardBorder="rgba(0,0,0,0.08)"
      darkMode={false}
      overlayTheme={buildOverlayWorkbenchTheme(false)}
    />
  );
  if (!preference) {
    return renderToStaticMarkup(panel);
  }
  return renderToStaticMarkup(
    <I18nProvider
      preference={preference}
      systemLanguages={[preference]}
      onPreferenceChange={() => undefined}
    >
      {panel}
    </I18nProvider>,
  );
};

describe('AIMCPServerValidationPanel', () => {

  it('renders localized summary chrome while preserving issue title and detail as supplied', () => {
    const markup = renderPanel(buildValidation(), 'en-US');

    expect(markup).toContain('Configuration check');
    expect(markup).toContain('Needs fix');
    expect(markup).toContain('Found 1 issue that must be fixed before testing or saving.');
    expect(markup).toContain('启动命令未填写');
    expect(markup).toContain('至少填写 node、uvx、python 或本机 exe 路径');
  });

  it('falls back to English without an i18n provider and renders ready summary', () => {
    const markup = renderPanel(buildValidation({
      issues: [],
      errorCount: 0,
      warningCount: 0,
      canTest: true,
      canSave: true,
    }));

    expect(markup).toContain('Configuration check');
    expect(markup).toContain('The current configuration can be tested and saved.');
  });
});
