import { describe, expect, it, vi } from 'vitest';

import {
  builtinAIStatusMessageKey,
  notifyBuiltinAILoginWake,
  runBuiltinAILogin,
  waitUnlessWoken,
  type BuiltinAILoginService,
} from './builtinAILogin';

const device = { deviceCode: 'dev-1', userCode: 'ABCD-EFGH', verificationUri: 'https://ai.example/device', verificationUriComplete: 'https://ai.example/device?user_code=ABCD-EFGH', expiresInSeconds: 600, intervalSeconds: 5 };

const instant = () => Promise.resolve();

describe('runBuiltinAILogin', () => {
  it('does not open a browser when the stored login is still valid', async () => {
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: true, state: 'ready' }),
      AIStartBuiltinAILogin: vi.fn(),
      AIPollBuiltinAILogin: vi.fn(),
    } as unknown as BuiltinAILoginService;
    const openURL = vi.fn();

    const outcome = await runBuiltinAILogin(service, { openURL, wait: instant });

    expect(outcome.kind).toBe('ready');
    expect(openURL).not.toHaveBeenCalled();
    expect(service.AIStartBuiltinAILogin).not.toHaveBeenCalled();
  });

  it('keeps a signed-in user signed in when the gateway is merely unreachable', async () => {
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: true, state: 'network_error', message: 'offline' }),
      AIStartBuiltinAILogin: vi.fn(),
      AIPollBuiltinAILogin: vi.fn(),
    } as unknown as BuiltinAILoginService;
    const openURL = vi.fn();

    const outcome = await runBuiltinAILogin(service, { openURL, wait: instant });

    expect(outcome.kind).toBe('retry');
    expect(openURL).not.toHaveBeenCalled();
  });

  it('runs the device flow when there is no valid login and tolerates dropped polls', async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce({ status: 'pending', authenticated: false })
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ status: 'authorized', authenticated: true });
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: false, state: 'login_required' }),
      AIStartBuiltinAILogin: vi.fn().mockResolvedValue(device),
      AIPollBuiltinAILogin: poll,
    } as unknown as BuiltinAILoginService;
    const openURL = vi.fn();

    const outcome = await runBuiltinAILogin(service, { openURL, wait: instant });

    expect(outcome.kind).toBe('authorized');
    expect(openURL).toHaveBeenCalledWith(device.verificationUriComplete);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('gives up after repeated poll failures instead of spinning until the code expires', async () => {
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: false }),
      AIStartBuiltinAILogin: vi.fn().mockResolvedValue(device),
      AIPollBuiltinAILogin: vi.fn().mockRejectedValue(new Error('down')),
    } as unknown as BuiltinAILoginService;

    const outcome = await runBuiltinAILogin(service, { openURL: vi.fn(), wait: instant });

    expect(outcome).toEqual({ kind: 'failed', message: 'down' });
  });

  it('never polls faster than the gateway asks', async () => {
    const waits: number[] = [];
    const poll = vi.fn()
      .mockResolvedValueOnce({ status: 'pending', retryAfterSeconds: 10 })
      .mockResolvedValueOnce({ status: 'pending', retryAfterSeconds: 5 })
      .mockResolvedValueOnce({ status: 'authorized' });
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: false }),
      AIStartBuiltinAILogin: vi.fn().mockResolvedValue(device),
      AIPollBuiltinAILogin: poll,
    } as unknown as BuiltinAILoginService;

    await runBuiltinAILogin(service, { openURL: vi.fn(), wait: async (ms) => { waits.push(ms); } });

    expect(waits).toEqual([5000, 10000, 5000]);
  });

  it('reports an expired or denied authorization with the backend message', async () => {
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: false }),
      AIStartBuiltinAILogin: vi.fn().mockResolvedValue(device),
      AIPollBuiltinAILogin: vi.fn().mockResolvedValue({ status: 'expired', message: 'code expired' }),
    } as unknown as BuiltinAILoginService;

    expect(await runBuiltinAILogin(service, { openURL: vi.fn(), wait: instant })).toEqual({ kind: 'failed', message: 'code expired' });
  });

  it('stops polling when the caller cancels (settings page closed)', async () => {
    let cancelled = false;
    const poll = vi.fn().mockResolvedValue({ status: 'pending' });
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: false }),
      AIStartBuiltinAILogin: vi.fn().mockResolvedValue(device),
      AIPollBuiltinAILogin: poll,
    } as unknown as BuiltinAILoginService;

    const outcome = await runBuiltinAILogin(service, { openURL: vi.fn(), wait: async () => { cancelled = true; }, isCancelled: () => cancelled });

    expect(outcome.kind).toBe('cancelled');
    expect(poll).not.toHaveBeenCalled();
  });

  it('times out when the user never completes the browser step', async () => {
    let clock = 0;
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: false }),
      AIStartBuiltinAILogin: vi.fn().mockResolvedValue({ ...device, expiresInSeconds: 30 }),
      AIPollBuiltinAILogin: vi.fn().mockResolvedValue({ status: 'pending' }),
    } as unknown as BuiltinAILoginService;

    const outcome = await runBuiltinAILogin(service, { openURL: vi.fn(), wait: async (ms) => { clock += ms; }, now: () => clock });

    expect(outcome.kind).toBe('timeout');
  });

  it('reports unavailable when the bridge methods are missing', async () => {
    expect((await runBuiltinAILogin({}, { openURL: vi.fn() })).kind).toBe('unavailable');
  });
});

describe('runBuiltinAILogin and the usage rules', () => {
  const signedOut = () => ({
    AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: false, state: 'login_required' }),
    AIStartBuiltinAILogin: vi.fn().mockResolvedValue(device),
    AIPollBuiltinAILogin: vi.fn().mockResolvedValue({ status: 'authorized', authenticated: true }),
  });

  it('starts nothing, and opens no browser, when the person declines the rules', async () => {
    const service = signedOut();
    const openURL = vi.fn();
    const requireTerms = vi.fn().mockResolvedValue(false);

    const outcome = await runBuiltinAILogin(service as unknown as BuiltinAILoginService, { openURL, wait: instant, requireTerms });

    expect(outcome.kind).toBe('cancelled');
    expect(requireTerms).toHaveBeenCalledTimes(1);
    expect(service.AIStartBuiltinAILogin).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
  });

  it('goes on to the browser sign-in once the rules are accepted', async () => {
    const service = signedOut();
    const openURL = vi.fn();
    const order: string[] = [];
    const requireTerms = vi.fn(async () => { order.push('terms'); return true; });
    service.AIStartBuiltinAILogin.mockImplementation(async () => { order.push('start'); return device; });

    const outcome = await runBuiltinAILogin(service as unknown as BuiltinAILoginService, { openURL, wait: instant, requireTerms });

    expect(outcome.kind).toBe('authorized');
    expect(order).toEqual(['terms', 'start']);
    expect(openURL).toHaveBeenCalledWith(device.verificationUriComplete);
  });

  it('does not ask again of someone whose login is still good', async () => {
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: true, state: 'ready' }),
      AIStartBuiltinAILogin: vi.fn(),
      AIPollBuiltinAILogin: vi.fn(),
    } as unknown as BuiltinAILoginService;
    const requireTerms = vi.fn().mockResolvedValue(false);

    const outcome = await runBuiltinAILogin(service, { openURL: vi.fn(), wait: instant, requireTerms });

    expect(outcome.kind).toBe('ready');
    expect(requireTerms).not.toHaveBeenCalled();
  });

  it('signs in as before for a caller that passes no rules to ask', async () => {
    const outcome = await runBuiltinAILogin(signedOut() as unknown as BuiltinAILoginService, { openURL: vi.fn(), wait: instant });
    expect(outcome.kind).toBe('authorized');
  });
});

describe('the browser step of the sign-in', () => {
  it('hands over the code to show in GoNavi, so the person can compare it with the page', async () => {
    const service = {
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: false, state: 'login_required' }),
      AIStartBuiltinAILogin: vi.fn().mockResolvedValue(device),
      AIPollBuiltinAILogin: vi.fn().mockResolvedValue({ status: 'authorized', authenticated: true }),
    } as unknown as BuiltinAILoginService;
    const onPending = vi.fn();
    const openURL = vi.fn();

    await runBuiltinAILogin(service, { openURL, wait: instant, onPending });

    expect(onPending).toHaveBeenCalledTimes(1);
    expect(onPending).toHaveBeenCalledWith({ userCode: 'ABCD-EFGH', verificationURL: device.verificationUriComplete });
    // The browser is opened first, then the code is shown: both say the same thing.
    expect(openURL.mock.invocationCallOrder[0]).toBeLessThan(onPending.mock.invocationCallOrder[0]);
  });

  it('shows no code when no browser step happens', async () => {
    const onPending = vi.fn();
    await runBuiltinAILogin({
      AIGetBuiltinAIStatus: vi.fn().mockResolvedValue({ authenticated: true, state: 'ready' }),
      AIStartBuiltinAILogin: vi.fn(),
      AIPollBuiltinAILogin: vi.fn(),
    } as unknown as BuiltinAILoginService, { openURL: vi.fn(), wait: instant, onPending });
    expect(onPending).not.toHaveBeenCalled();
  });

  it('stops waiting as soon as the browser sends the person back to GoNavi', async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      const waiting = waitUnlessWoken(5_000).then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(100);
      expect(finished).toBe(false);
      notifyBuiltinAILoginWake();
      await vi.advanceTimersByTimeAsync(0);
      await waiting;
      expect(finished).toBe(true);
      // A wake with nobody waiting is harmless, and a later wait still runs its full time.
      notifyBuiltinAILoginWake();
      let later = false;
      void waitUnlessWoken(1_000).then(() => { later = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(later).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(later).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('builtinAIStatusMessageKey', () => {
  it('maps every backend state to a distinct, actionable message', () => {
    const keys = ['ready', 'login_expired', 'network_error', 'service_unavailable', 'quota_unavailable', 'login_required']
      .map((state) => builtinAIStatusMessageKey({ state } as never));
    expect(new Set(keys).size).toBe(keys.length);
    expect(builtinAIStatusMessageKey(null)).toBe('ai_settings.provider_preset.gonavi_ai.sign_in_required');
  });
});
