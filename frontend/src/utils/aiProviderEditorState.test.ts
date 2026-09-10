import { describe, expect, it } from 'vitest';

import {
  buildAddProviderEditorSession,
  buildClosedProviderEditorSession,
  buildEditProviderEditorSession,
} from './aiProviderEditorState';

describe('aiProviderEditorState', () => {
  it('starts add flow with idle test state', () => {
    const session = buildAddProviderEditorSession({
      presetBackendType: 'openai',
      presetBaseUrl: 'https://api.openai.com/v1',
      presetModel: 'gpt-4.1',
    });

    expect(session.isEditing).toBe(true);
    expect(session.testStatus).toBe('idle');
  });

  it('carries local CLI authentication into a new provider form', () => {
    const session = buildAddProviderEditorSession({
      presetKey: 'codex',
      presetBackendType: 'custom',
      presetBaseUrl: '',
      presetModel: '',
      apiFormat: 'codex-cli',
      authMode: 'local-cli',
      connectionMode: 'subscription',
    });

    expect(session.editingProvider?.authMode).toBe('local-cli');
    expect(session.formValues).toMatchObject({ authMode: 'local-cli', connectionMode: 'subscription', apiKey: '' });
  });

  it('starts edit flow with the target provider', () => {
    const session = buildEditProviderEditorSession({
      provider: {
        id: 'provider-1',
        type: 'openai',
        name: 'OpenAI',
        apiKey: '',
        hasSecret: true,
      },
    });

    expect(session.isEditing).toBe(true);
    expect(session.editingProvider?.id).toBe('provider-1');
  });

  it('clears edit session when the modal closes', () => {
    const session = buildClosedProviderEditorSession();

    expect(session.isEditing).toBe(false);
    expect(session.editingProvider).toBeNull();
  });
});
