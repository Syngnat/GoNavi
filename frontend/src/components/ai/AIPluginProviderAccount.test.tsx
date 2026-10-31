// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ PluginInvoke: vi.fn() }));
vi.mock('../../../wailsjs/go/app/App', () => host);
vi.mock('../../i18n/runtime', () => ({ syncLanguageRuntime: vi.fn(async () => undefined) }));

import { I18nProvider } from '../../i18n/provider';
import { loadCatalog } from '../../i18n/catalog';
import AIPluginProviderAccount from './AIPluginProviderAccount';

const PLUGIN_ID = 'com.gonavi.test-provider';

// Captured once, before anything mocks it. Wrapping window.getComputedStyle after
// a spy is installed would forward the mock to itself and overflow the stack.
const nativeGetComputedStyle = window.getComputedStyle.bind(window);

// I18nProvider renders null until the catalog registry is primed, so load it before mounting.
beforeAll(async () => { await loadCatalog('en-US'); });

const wrap = (data: unknown) => ({ success: true, message: '', data: { ok: true, data } });

const signedOut = wrap({ state: 'signed_out' });
const readyStatus = wrap({
  state: 'ready',
  email: 'user@example.com',
  userId: '43',
  balance: 63.69,
  frozenBalance: 0,
  totalRecharged: 100,
  concurrency: 5,
});
const keyItems = wrap({
  state: 'ready',
  items: [
    {
      id: 'k1', name: 'default', key: 'sk-1234567890abcd', status: 'active',
      groupName: 'vip', rateMultiplier: 1.5, quota: 100, quotaUsed: 12, lastUsedAt: '2026-01-02T03:04:05Z',
    },
    {
      id: 'k2', name: 'unbounded', key: 'sk-zzzzzzzzzzzz9999', status: 'active',
      groupName: '', quota: 0, quotaUsed: 0, lastUsedAt: '',
    },
  ],
});

let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
let clipboard: { writeText: ReturnType<typeof vi.fn> };

const commands = () => host.PluginInvoke.mock.calls.map((call) => String(call[1]));
const buttonByText = (label: string) => [...container.querySelectorAll('button')]
  .find((item) => (item.textContent ?? '').includes(label) || item.getAttribute('aria-label') === label);
const click = async (label: string) => {
  const button = buttonByText(label);
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => { button.click(); });
};
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  }));
  // rc-table measures the scrollbar through getComputedStyle; jsdom throws on the
  // pseudo-element argument, so answer without the second parameter.
  window.getComputedStyle = ((element: Element) => nativeGetComputedStyle(element)) as typeof window.getComputedStyle;
  clipboard = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(window.navigator, 'clipboard', { value: clipboard, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  container.remove();
  window.getComputedStyle = nativeGetComputedStyle;
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const renderWith = async (pluginId?: string) => {
  await act(async () => {
    root.render(
      <I18nProvider preference="en-US" onPreferenceChange={() => undefined}>
        <AIPluginProviderAccount pluginId={pluginId} />
      </I18nProvider>,
    );
  });
};
const renderAccount = () => renderWith(PLUGIN_ID);

// Every command is answered from one map so each test states its scenario once.
const routeHost = (handlers: Record<string, unknown | (() => unknown)>) => {
  host.PluginInvoke.mockImplementation(async (_id: string, command: string, args?: string) => {
    const handler = handlers[command];
    if (handler === undefined) return { success: false, message: '', data: null };
    return typeof handler === 'function' ? (handler as (payload?: string) => unknown)(args) : handler;
  });
};

describe('AIPluginProviderAccount', () => {
  it('renders nothing when the host reports Success false', async () => {
    host.PluginInvoke.mockResolvedValue({ success: false, message: 'command not found', data: null });
    await renderAccount();
    expect(host.PluginInvoke).toHaveBeenCalledWith(PLUGIN_ID, 'account.status', '{}');
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing without a plugin id', async () => {
    await renderWith(undefined);
    expect(host.PluginInvoke).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('logs in, polls twice, then shows the balance once ready', async () => {
    vi.useFakeTimers();
    let polls = 0;
    routeHost({
      'account.status': () => (polls >= 3 ? readyStatus : signedOut),
      'account.login': wrap({ started: true }),
      'account.poll': () => {
        polls += 1;
        return wrap({ state: polls < 3 ? 'pending' : 'ready' });
      },
      'account.keys': keyItems,
    });

    await renderAccount();
    expect(container.textContent).toContain('Sign in with browser');

    await click('Sign in with browser');
    expect(commands().filter((command) => command === 'account.login')).toHaveLength(1);
    expect(container.textContent).toContain('Waiting for browser sign-in');

    await advance(2000);
    await advance(2000);
    expect(container.textContent).toContain('Waiting for browser sign-in');

    await advance(2000);
    expect(commands().filter((command) => command === 'account.poll')).toHaveLength(3);
    expect(container.textContent).toContain('user@example.com');
    expect(container.textContent).toContain('63.69');
    expect(container.textContent).toContain('Available balance');
    expect(container.textContent).not.toContain('Waiting for browser sign-in');
  });

  it('stops polling after the five minute budget and offers a retry', async () => {
    vi.useFakeTimers();
    routeHost({
      'account.status': signedOut,
      'account.login': wrap({ started: true }),
      'account.poll': wrap({ state: 'pending' }),
    });

    await renderAccount();
    await click('Sign in with browser');
    await advance(300000);

    expect(commands().filter((command) => command === 'account.poll')).toHaveLength(150);
    expect(container.textContent).toContain('Sign-in was not completed in time');
    expect(container.textContent).toContain('Sign in with browser');
    expect(container.textContent).not.toContain('Waiting for browser sign-in');

    const callsAfterTimeout = host.PluginInvoke.mock.calls.length;
    await advance(20000);
    expect(host.PluginInvoke.mock.calls.length).toBe(callsAfterTimeout);
  });

  it('masks keys, reveals on demand and copies the raw value', async () => {
    routeHost({ 'account.status': readyStatus, 'account.keys': keyItems });

    await renderAccount();
    expect(container.textContent).toContain('sk-****abcd');
    expect(container.textContent).not.toContain('sk-1234567890abcd');
    expect(container.textContent).toContain('vip ×1.5');
    expect(container.textContent).toContain('88 left');
    expect(container.textContent).toContain('Unlimited');
    expect(container.textContent).toContain('Never');
    expect(container.textContent).toContain('Signed in as');
    expect(container.textContent).toContain('(2)');

    await click('Show');
    expect(container.textContent).toContain('sk-1234567890abcd');
    expect(container.textContent).toContain('sk-zzzzzzzzzzzz9999');
    await click('Hide');
    expect(container.textContent).toContain('sk-****abcd');
    expect(container.textContent).not.toContain('sk-1234567890abcd');

    await act(async () => {
      const copyButtons = [...container.querySelectorAll('button')].filter((item) => item.getAttribute('aria-label') === 'Copy');
      if (copyButtons.length === 0) throw new Error('copy button not found');
      copyButtons[0].click();
    });
    expect(clipboard.writeText).toHaveBeenCalledWith('sk-1234567890abcd');
  });

  it('applies a listed key through the use action', async () => {
    const onUseKey = vi.fn();
    routeHost({ 'account.status': readyStatus, 'account.keys': keyItems });
    await act(async () => {
      root.render(
        <I18nProvider preference="en-US" onPreferenceChange={() => undefined}>
          <AIPluginProviderAccount pluginId={PLUGIN_ID} onUseKey={onUseKey} />
        </I18nProvider>,
      );
    });
    await click('Use');
    expect(onUseKey).toHaveBeenCalledWith('sk-1234567890abcd');
  });

  it('returns to the signed out state after logging out', async () => {
    routeHost({ 'account.status': readyStatus, 'account.keys': keyItems, 'account.logout': wrap({ state: 'signed_out' }) });

    await renderAccount();
    expect(container.textContent).toContain('user@example.com');

    await click('Sign out');
    expect(commands()).toContain('account.logout');
    expect(container.textContent).toContain('Sign in with browser');
    expect(container.textContent).not.toContain('user@example.com');
    expect(container.textContent).not.toContain('Available balance');
  });

  it('creates a key with the chosen name and group', async () => {
    let payload = '';
    routeHost({
      'account.status': readyStatus,
      'account.keys': keyItems,
      'account.groups': wrap({ state: 'ready', items: [{ id: 34, name: 'vip', rateMultiplier: 1.5 }] }),
      'account.createKey': (args?: string) => {
        payload = String(args ?? '');
        return wrap({
          id: 3, name: 'GoNavi', key: 'sk-newkeyvalue', status: 'active',
          groupName: 'vip', quota: 0, quotaUsed: 0, lastUsedAt: '',
        });
      },
    });
    await renderAccount();
    expect(commands()).toContain('account.groups');
    await click('New key');
    const input = container.querySelector('.gn-account-key-input') as HTMLInputElement;
    await act(async () => {
      (container.querySelector('.gn-account-key-select-btn') as HTMLButtonElement).click();
    });
    const option = [...container.querySelectorAll('.gn-account-group-option')]
      .find((item) => (item.textContent ?? '').includes('vip ×1.5'));
    expect(option?.querySelector('.gn-account-key-group')).toBeTruthy();
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(input, 'GoNavi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await click('Create');
    expect(JSON.parse(payload)).toEqual({ name: 'GoNavi', groupId: 34 });
    expect(commands()).toContain('account.createKey');
  });

  it('updates a listed key name and group', async () => {
    let payload = '';
    routeHost({
      'account.status': readyStatus,
      'account.keys': wrap({
        state: 'ready',
        items: [{
          id: 12, name: 'default', key: 'sk-1234567890abcd', status: 'active',
          groupId: 34, groupName: 'vip', rateMultiplier: 1.5, quota: 0, quotaUsed: 0, lastUsedAt: '',
        }],
      }),
      'account.groups': wrap({ state: 'ready', items: [{ id: 34, name: 'vip', rateMultiplier: 1.5 }] }),
      'account.updateKey': (args?: string) => {
        payload = String(args ?? '');
        return wrap({
          id: 12, name: 'renamed', key: 'sk-1234567890abcd', status: 'active',
          groupId: 34, groupName: 'vip', quota: 0, quotaUsed: 0, lastUsedAt: '',
        });
      },
    });
    await renderAccount();
    await click('Edit');
    const input = container.querySelector('.gn-account-key-input') as HTMLInputElement;
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(input, 'renamed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Save');
    expect(JSON.parse(payload)).toEqual({ id: 12, name: 'renamed', groupId: 34 });
    expect(commands()).toContain('account.updateKey');
  });

  it('deletes a listed key after confirmation', async () => {
    let payload = '';
    routeHost({
      'account.status': readyStatus,
      'account.keys': wrap({
        state: 'ready',
        items: [{
          id: 12, name: 'default', key: 'sk-1234567890abcd', status: 'active',
          groupName: 'vip', quota: 0, quotaUsed: 0, lastUsedAt: '',
        }],
      }),
      'account.deleteKey': (args?: string) => {
        payload = String(args ?? '');
        return wrap({ id: 12 });
      },
    });
    await renderAccount();
    await click('Delete');
    expect(commands()).not.toContain('account.deleteKey');
    await click('Confirm delete');
    expect(JSON.parse(payload)).toEqual({ id: 12 });
    expect(commands()).toContain('account.deleteKey');
  });

  it('searches keys by name and pages five at a time', async () => {
    const many = wrap({
      state: 'ready',
      items: Array.from({ length: 7 }, (_, index) => ({
        id: `k${index}`,
        name: index === 6 ? 'needle-key' : `key-${index}`,
        key: `sk-${index}xxx${index}yyy${index}zzz${index}`,
        status: 'active',
        groupName: '',
        quota: 0,
        quotaUsed: 0,
        lastUsedAt: '',
      })),
    });
    routeHost({ 'account.status': readyStatus, 'account.keys': many });
    await renderAccount();
    expect(container.querySelectorAll('.gn-account-key')).toHaveLength(5);
    expect(container.textContent).toContain('1–5 / 7');
    await click('Next page');
    expect(container.querySelectorAll('.gn-account-key')).toHaveLength(2);
    const input = container.querySelector('.gn-account-keys-search input') as HTMLInputElement;
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('.gn-account-key')).toHaveLength(1);
    expect(container.textContent).toContain('needle-key');
    expect(container.querySelector('.gn-account-keys-pager')).toBeNull();
  });

  it('keeps the balance area when the keys command fails', async () => {
    routeHost({
      'account.status': readyStatus,
      'account.keys': () => ({ success: true, message: '', data: { ok: false, error: { code: 'x', message: 'keys offline' } } }),
    });

    await renderAccount();
    expect(container.textContent).toContain('Available balance');
    expect(container.textContent).toContain('keys offline');
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    routeHost({
      'account.status': signedOut,
      'account.login': wrap({ started: true }),
      'account.poll': wrap({ state: 'pending' }),
    });

    await renderAccount();
    await click('Sign in with browser');
    await advance(2000);
    expect(commands().filter((command) => command === 'account.poll')).toHaveLength(1);

    act(() => root.unmount());
    mounted = false;
    const callsAfterUnmount = host.PluginInvoke.mock.calls.length;
    await advance(10000);
    expect(host.PluginInvoke.mock.calls.length).toBe(callsAfterUnmount);
  });
});
