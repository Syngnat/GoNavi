import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type { ParsedMCPEnvDraft } from '../../utils/mcpEnvDraft';
import type { MCPServerDraftValidation } from '../../utils/mcpServerValidation';
import AIMCPServerFormPanel from './AIMCPServerFormPanel';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

const formSource = readFileSync(new URL('./AIMCPServerFormPanel.tsx', import.meta.url), 'utf8');
const helpBlockSource = readFileSync(new URL('./AIMCPHelpBlock.tsx', import.meta.url), 'utf8');

const REQUIRED_KEYS = [
  'ai_settings.mcp_server.help.field_state.required',
  'ai_settings.mcp_server.help.field_state.fixed',
  'ai_settings.mcp_server.help.field_state.optional',
  'ai_settings.mcp_server.help.example_prefix',
  'ai_settings.mcp_server.form.name.title',
  'ai_settings.mcp_server.form.name.description',
  'ai_settings.mcp_server.form.name.placeholder',
  'ai_settings.mcp_server.form.enabled.title',
  'ai_settings.mcp_server.form.enabled.description',
  'ai_settings.mcp_server.form.enabled.option.enabled',
  'ai_settings.mcp_server.form.enabled.option.disabled',
  'ai_settings.mcp_server.form.transport.title',
  'ai_settings.mcp_server.form.transport.description',
  'ai_settings.mcp_server.form.command.title',
  'ai_settings.mcp_server.form.command.description',
  'ai_settings.mcp_server.form.command.placeholder',
  'ai_settings.mcp_server.form.timeout.title',
  'ai_settings.mcp_server.form.timeout.description',
  'ai_settings.mcp_server.form.timeout.placeholder',
  'ai_settings.mcp_server.form.timeout.preset.default',
  'ai_settings.mcp_server.form.timeout.preset.relaxed',
  'ai_settings.mcp_server.form.timeout.preset.slow',
  'ai_settings.mcp_server.form.args.title',
  'ai_settings.mcp_server.form.args.description',
  'ai_settings.mcp_server.form.args.placeholder',
  'ai_settings.mcp_server.form.launch_preview.title',
  'ai_settings.mcp_server.form.launch_preview.description',
  'ai_settings.mcp_server.form.env.title',
  'ai_settings.mcp_server.form.env.description',
  'ai_settings.mcp_server.form.env.placeholder',
  'ai_settings.mcp_server.form.env_status.invalid',
  'ai_settings.mcp_server.form.env_status.valid',
  'ai_settings.mcp_server.form.env_status.empty',
  'ai_settings.mcp_server.form.instructions.title',
  'ai_settings.mcp_server.form.instructions.test_title',
  'ai_settings.mcp_server.form.instructions.test_description',
  'ai_settings.mcp_server.form.instructions.save_title',
  'ai_settings.mcp_server.form.instructions.save_description',
  'ai_settings.mcp_server.form.instructions.tools_found',
  'ai_settings.mcp_server.form.instructions.test_first',
  'ai_settings.mcp_server.form.action.test',
  'ai_settings.mcp_server.form.action.save',
  'ai_settings.mcp_server.form.action.delete',
  'ai_settings.mcp_server.form.action.delete_confirm',
  'ai_settings.mcp_server.form.action.delete_ok',
  'ai_settings.mcp_server.form.action.delete_cancel',
];

const buildValidation = (): MCPServerDraftValidation => ({
  issues: [],
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
  canTest: true,
  canSave: true,
});

const buildEnvDraft = (patch: Partial<ParsedMCPEnvDraft> = {}): ParsedMCPEnvDraft => ({
  env: {},
  totalLines: 0,
  validLines: 0,
  invalidLines: [],
  ...patch,
});

const renderPanel = (preference?: 'en-US' | 'zh-CN', parsedEnvDraft = buildEnvDraft()) => {
  const panel = (
    <AIMCPServerFormPanel
      server={{
        id: 'mcp-1',
        name: 'Filesystem',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--stdio'],
        env: parsedEnvDraft.env,
        enabled: true,
        timeoutSeconds: 20,
      }}
      serverTools={[]}
      launchPreview="node server.js --stdio"
      envDraft={parsedEnvDraft.validLines > 0 || parsedEnvDraft.invalidLines.length > 0 ? 'OPENAI_API_KEY=...' : ''}
      parsedEnvDraft={parsedEnvDraft}
      validation={buildValidation()}
      cardBorder="rgba(0,0,0,0.08)"
      inputBg="#fff"
      darkMode={false}
      overlayTheme={buildOverlayWorkbenchTheme(false)}
      loading={false}
      onChange={() => undefined}
      onEnvDraftChange={() => undefined}
      onTest={() => undefined}
      onSave={() => undefined}
      onDelete={() => undefined}
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

describe('AIMCPServerFormPanel', () => {
  it('uses catalog keys instead of hard-coded Chinese form chrome', () => {
    for (const key of REQUIRED_KEYS) {
      expect(formSource + helpBlockSource).toContain(key);
    }
  });

  it('renders English fallback without an i18n provider while keeping raw command examples unchanged', () => {
    const markup = renderPanel();

    expect(markup).toContain('Service name');
    expect(markup).toContain('Enabled');
    expect(markup).toContain('Startup command');
    expect(markup).toContain('Actual launch command preview');
    expect(markup).toContain('Action guide');
    expect(markup).toContain('Test tool discovery');
    expect(markup).toContain('Save');
    expect(markup).toContain('Delete');
    expect(markup).toContain('npx / node / uvx / python / docker');
    expect(markup).toContain('node server.js --stdio');
    expect(markup).not.toContain('服务名称');
    expect(markup).not.toContain('操作说明');
  });

  it('renders localized env status text with count and invalid line placeholders', () => {
    const markup = renderPanel('en-US', buildEnvDraft({
      env: { OPENAI_API_KEY: '...' },
      validLines: 1,
      invalidLines: ['bad line'],
    }));

    expect(markup).toContain('Detected 1 environment variable');
    expect(markup).toContain('1 invalid line');
    expect(markup).toContain('bad line');
  });
});
