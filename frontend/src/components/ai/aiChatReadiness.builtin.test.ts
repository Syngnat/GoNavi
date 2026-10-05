import { describe, expect, it } from 'vitest';

import { buildAIComposerNotice } from '../../utils/aiComposerNotice';
import { buildAIChatReadinessSnapshot } from './aiChatReadiness';

const builtin = {
  id: 'gonavi-ai', type: 'custom' as const, name: 'GoNavi AI', apiKey: '', hasSecret: false,
  baseUrl: '', model: '', models: ['gonavi-sql'], maxTokens: 1024, temperature: 0.1,
};

describe('built-in GoNavi AI readiness', () => {
  it('offers a sign-in action instead of "missing key / missing address"', () => {
    const snapshot = buildAIChatReadinessSnapshot({ providers: [builtin], activeProviderId: 'gonavi-ai' });

    expect(snapshot.status).toBe('login_required');
    expect(snapshot.ready).toBe(false);
    expect(snapshot.action).toEqual({ key: 'builtin-login', label: 'Sign in to GoNavi AI' });
    expect(snapshot.title).toBe('Sign in to use GoNavi AI');
    expect(snapshot.title).not.toMatch(/missing/i);
  });

  it('is ready once signed in, with the backend-completed address and model', () => {
    const snapshot = buildAIChatReadinessSnapshot({
      providers: [{ ...builtin, hasSecret: true, baseUrl: 'https://ai.syngnat.top/v1', model: 'gonavi-sql' }],
      activeProviderId: 'gonavi-ai',
    });

    expect(snapshot.status).toBe('ready');
    expect(snapshot.ready).toBe(true);
  });

  it('does not change how ordinary providers report a missing key', () => {
    const snapshot = buildAIChatReadinessSnapshot({
      providers: [{ ...builtin, id: 'provider-1', name: 'Custom', baseUrl: 'https://x/v1', model: 'm' }],
      activeProviderId: 'provider-1',
    });

    expect(snapshot.status).toBe('provider_incomplete');
    expect(snapshot.issues).toContain('missing_secret');
  });
});

describe('built-in sign-in composer notices', () => {
  it('builds the login-required notice with the sign-in action', () => {
    const notice = buildAIComposerNotice((key) => key, { kind: 'builtin_login_required' });

    expect(notice?.action?.key).toBe('builtin-login');
  });

  it('shows the real failure detail and keeps the retry action', () => {
    const notice = buildAIComposerNotice((key) => key, { kind: 'builtin_login_failed', detail: 'gateway unreachable' });

    expect(notice).toEqual(expect.objectContaining({ tone: 'error', description: 'gateway unreachable' }));
    expect(notice?.action?.key).toBe('builtin-login');
  });
});
