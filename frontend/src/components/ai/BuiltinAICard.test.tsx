import React from 'react';
import { Button } from 'antd';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { composerNoticeDescriptorFor } from './composerNoticeForReadiness';
import { BuiltinAICard } from './BuiltinAICard';

vi.mock('antd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('antd')>()),
  // The static message API needs a DOM; the toast itself is not under test here.
  message: { success: vi.fn(), error: vi.fn() },
  // A button that is loading draws antd's spinner icon, whose style hook needs a DOM.
  Button: ({ children, onClick, loading }: { children?: React.ReactNode; onClick?: () => void; loading?: boolean }) => (
    <button type="button" onClick={onClick} data-loading={loading ? 'true' : undefined}>{children}</button>
  ),
}));

const service = vi.hoisted(() => ({
  AIGetBuiltinAIStatus: vi.fn(),
  AIStartBuiltinAILogin: vi.fn(),
  AIPollBuiltinAILogin: vi.fn(),
  AILogoutBuiltinAI: vi.fn(),
}));

const copy = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const textOf = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());
const buttonLabels = (renderer: ReactTestRenderer): string[] =>
  renderer.root.findAllByType(Button).map((button) => String(button.props.children));

describe('BuiltinAICard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      go: { aiservice: { Service: service } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      setTimeout,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const render = async (onChanged?: () => void) => {
    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(<BuiltinAICard copy={copy} onChanged={onChanged} />); });
    await flush();
    return renderer!;
  };

  it('offers sign-in, and nothing to sign out of, before the first login', async () => {
    service.AIGetBuiltinAIStatus.mockResolvedValue({ enabled: true, authenticated: false, state: 'login_required', message: 'login required' });
    const renderer = await render();

    expect(textOf(renderer)).toContain('ai_settings.provider_preset.gonavi_ai.sign_in_required');
    expect(buttonLabels(renderer)).toEqual(['ai_settings.provider_preset.gonavi_ai.sign_in']);
    // A "sign in required" state needs no technical detail line.
    expect(textOf(renderer)).not.toContain('login required"');
  });

  it('shows the signed-in state, the quota and a sign-out action', async () => {
    service.AIGetBuiltinAIStatus.mockResolvedValue({
      enabled: true, authenticated: true, state: 'ready',
      quota: { dailyTokensUsed: 12, dailyTokenLimit: 60000, rolling5hTokensUsed: 5, rolling5hTokenLimit: 20000 },
    });
    const renderer = await render();

    expect(textOf(renderer)).toContain('ai_settings.provider_preset.gonavi_ai.signed_in');
    expect(textOf(renderer)).toContain('dailyUsed');
    expect(buttonLabels(renderer)).toEqual([
      'ai_settings.provider_preset.gonavi_ai.refresh_login',
      'ai_settings.provider_preset.gonavi_ai.sign_out',
    ]);
  });

  it('offers a retry, with the reason, when a signed-in user cannot reach the service', async () => {
    service.AIGetBuiltinAIStatus.mockResolvedValue({ enabled: true, authenticated: true, state: 'network_error', message: 'Cannot reach the GoNavi AI service' });
    const renderer = await render();

    expect(textOf(renderer)).toContain('ai_settings.provider_preset.gonavi_ai.state.network_error');
    expect(textOf(renderer)).toContain('Cannot reach the GoNavi AI service');
    expect(buttonLabels(renderer)[0]).toBe('ai_settings.provider_preset.gonavi_ai.retry');
  });

  it('shows the device code while the browser step is open, and offers to reopen the page', async () => {
    // The usage rules were accepted before (node has no localStorage: a stand-in holds that).
    const accepted = JSON.stringify({ version: 1 });
    vi.stubGlobal('localStorage', { getItem: () => accepted, setItem: () => undefined, removeItem: () => undefined });
    service.AIGetBuiltinAIStatus.mockResolvedValue({ enabled: true, authenticated: false, state: 'login_required' });
    service.AIStartBuiltinAILogin.mockResolvedValue({
      deviceCode: 'dev-1', userCode: 'RQFU-8BZX', verificationUri: 'https://ai.example/device',
      verificationUriComplete: 'https://ai.example/device?user_code=RQFU-8BZX', expiresInSeconds: 600, intervalSeconds: 5,
    });
    let finishPoll: (value: unknown) => void = () => undefined;
    service.AIPollBuiltinAILogin.mockReturnValue(new Promise((resolve) => { finishPoll = resolve; }));

    const renderer = await render();
    await act(async () => { renderer.root.findAllByType(Button)[0].props.onClick(); });
    await flush();
    // The poll waits five seconds before asking; the code is already on screen.
    expect(textOf(renderer)).toContain('ai_settings.provider_preset.gonavi_ai.waiting_browser|{\\"code\\":\\"RQFU-8BZX\\"}');
    expect(buttonLabels(renderer)).toContain('ai_settings.provider_preset.gonavi_ai.reopen_browser');
    finishPoll({ status: 'authorized', authenticated: true });
    act(() => renderer.unmount());
  });

  it('signs out through the backend, refreshes its own state and tells the provider list', async () => {
    service.AIGetBuiltinAIStatus.mockResolvedValueOnce({ enabled: true, authenticated: true, state: 'ready' });
    service.AIGetBuiltinAIStatus.mockResolvedValue({ enabled: true, authenticated: false, state: 'login_required' });
    service.AILogoutBuiltinAI.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    const renderer = await render(onChanged);

    const signOut = renderer.root.findAllByType(Button).find((button) => String(button.props.children).endsWith('sign_out'));
    await act(async () => { signOut!.props.onClick(); });
    await flush();

    expect(service.AILogoutBuiltinAI).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalled();
    expect(buttonLabels(renderer)).toEqual(['ai_settings.provider_preset.gonavi_ai.sign_in']);
  });
});

describe('composerNoticeDescriptorFor', () => {
  it('maps every blocking readiness status to a notice, and ready to none', () => {
    expect(composerNoticeDescriptorFor({ status: 'missing_provider', issues: [] })).toEqual({ kind: 'missing_provider' });
    expect(composerNoticeDescriptorFor({ status: 'login_required', issues: ['missing_secret'] })).toEqual({ kind: 'builtin_login_required' });
    expect(composerNoticeDescriptorFor({ status: 'provider_incomplete', issues: ['missing_base_url'] })).toEqual({ kind: 'provider_incomplete', issues: ['missing_base_url'] });
    expect(composerNoticeDescriptorFor({ status: 'missing_model', issues: [] })).toEqual({ kind: 'missing_model' });
    expect(composerNoticeDescriptorFor({ status: 'loading_models', issues: [] })).toEqual({ kind: 'missing_model' });
    expect(composerNoticeDescriptorFor({ status: 'ready', issues: [] })).toBeNull();
  });
});
