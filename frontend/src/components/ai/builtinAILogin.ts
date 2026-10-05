import type { ai } from '../../../wailsjs/go/models';
import { BrowserOpenURL, EventsOn } from '../../../wailsjs/runtime';

/** Fixed id of the GoNavi-hosted provider. The backend owns its identity. */
export const BUILTIN_AI_PROVIDER_ID = 'gonavi-ai';
export const AI_PROVIDER_CHANGED_EVENT = 'gonavi:ai:provider-changed';

export const isBuiltinAIProvider = (provider?: { id?: string } | null): boolean =>
  String(provider?.id || '').trim() === BUILTIN_AI_PROVIDER_ID;

export interface BuiltinAILoginService {
  AIGetBuiltinAIStatus?: () => Promise<ai.BuiltinAIStatus>;
  AIStartBuiltinAILogin?: () => Promise<ai.BuiltinAIDeviceCode>;
  AIPollBuiltinAILogin?: (deviceCode: string) => Promise<ai.BuiltinAILoginResult>;
  AILogoutBuiltinAI?: () => Promise<void>;
}

export type BuiltinAILoginOutcome =
  /** Already signed in and verified: no browser was opened. */
  | { kind: 'ready'; status: ai.BuiltinAIStatus }
  /** Signed in, but the Gateway could not be verified right now: retry later. */
  | { kind: 'retry'; status: ai.BuiltinAIStatus }
  | { kind: 'authorized' }
  | { kind: 'failed'; message: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' };

/** Sent by the desktop when the browser's "Return to GoNavi" link brought the window back. */
export const BUILTIN_AI_LOGIN_WAKE_EVENT = 'gonavi:deeplink:ai-login';

/** The code the person checks against the one on the browser page, and where that page is. */
export interface BuiltinAILoginPending {
  userCode: string;
  verificationURL: string;
}

export interface BuiltinAILoginOptions {
  openURL: (url: string) => void;
  /** Called once the browser has been sent to the Gateway: the code to show while waiting. */
  onPending?: (pending: BuiltinAILoginPending) => void;
  /**
   * Asked before a new sign-in begins (the usage rules): false means the person declined, and
   * nothing is started. Not asked when an existing login is still good.
   */
  requireTerms?: () => Promise<boolean>;
  isCancelled?: () => boolean;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_CONSECUTIVE_POLL_FAILURES = 3;

const wakeListeners = new Set<() => void>();
let wakeSubscribed = false;

/** Lets a wait in progress end now (the browser just sent the person back). */
export const notifyBuiltinAILoginWake = (): void => {
  [...wakeListeners].forEach((listener) => listener());
};

const subscribeToDesktopWake = (): void => {
  if (wakeSubscribed) return;
  try {
    EventsOn(BUILTIN_AI_LOGIN_WAKE_EVENT, notifyBuiltinAILoginWake);
    wakeSubscribed = true;
  } catch {
    // No desktop runtime (tests, the browser build): the poll interval alone applies.
  }
};

/** Waits ms, or less if the browser sends the person back to GoNavi in the meantime. */
export const waitUnlessWoken = (ms: number): Promise<void> => new Promise<void>((resolve) => {
  subscribeToDesktopWake();
  const done = () => {
    clearTimeout(timer);
    wakeListeners.delete(done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  wakeListeners.add(done);
});

const defaultWait = waitUnlessWoken;

const errorText = (error: unknown): string =>
  String((error as { message?: string } | null)?.message || error || '').trim();

/**
 * Signs in to GoNavi AI.
 *
 * An existing login is verified (and its refresh token used) first, so a
 * signed-in user never gets a browser window. Only an absent or rejected login
 * starts the device flow, whose polling tolerates a few dropped requests: the
 * user may still be typing their password in the browser.
 */
export const runBuiltinAILogin = async (
  service: BuiltinAILoginService,
  options: BuiltinAILoginOptions,
): Promise<BuiltinAILoginOutcome> => {
  if (typeof service.AIStartBuiltinAILogin !== 'function' || typeof service.AIPollBuiltinAILogin !== 'function') {
    return { kind: 'unavailable' };
  }
  const wait = options.wait ?? defaultWait;
  const now = options.now ?? Date.now;

  const status = typeof service.AIGetBuiltinAIStatus === 'function'
    ? await service.AIGetBuiltinAIStatus().catch(() => undefined)
    : undefined;
  if (status?.authenticated) {
    return status.state === 'ready' ? { kind: 'ready', status } : { kind: 'retry', status };
  }

  if (options.requireTerms && !(await options.requireTerms())) return { kind: 'cancelled' };

  let device: ai.BuiltinAIDeviceCode;
  try {
    device = await service.AIStartBuiltinAILogin();
  } catch (error) {
    return { kind: 'failed', message: errorText(error) };
  }
  const verificationURL = device.verificationUriComplete || device.verificationUri;
  if (verificationURL) options.openURL(verificationURL);
  options.onPending?.({ userCode: String(device.userCode || '').trim(), verificationURL: verificationURL || '' });

  const baseIntervalSeconds = Math.max(1, Number(device.intervalSeconds) || 5);
  const deadline = now() + Math.max(30, Number(device.expiresInSeconds) || 600) * 1000;
  let waitSeconds = baseIntervalSeconds;
  let consecutiveFailures = 0;
  while (now() < deadline) {
    await wait(waitSeconds * 1000);
    if (options.isCancelled?.()) return { kind: 'cancelled' };
    let result: ai.BuiltinAILoginResult;
    try {
      result = await service.AIPollBuiltinAILogin(device.deviceCode);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) return { kind: 'failed', message: errorText(error) };
      continue;
    }
    if (result.status === 'authorized') return { kind: 'authorized' };
    if (result.status === 'expired' || result.status === 'error') {
      return { kind: 'failed', message: String(result.message || '').trim() };
    }
    // The Gateway may ask the client to slow down; never poll faster than it says.
    waitSeconds = Math.max(baseIntervalSeconds, Number(result.retryAfterSeconds) || 0);
  }
  return { kind: 'timeout' };
};

/** Tells every chat runtime/settings view to re-read the provider list. */
export const notifyAIProviderChanged = (): void => {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AI_PROVIDER_CHANGED_EVENT));
};

/** i18n key describing a status the user can act on; undefined when ready. */
export const builtinAIStatusMessageKey = (status?: ai.BuiltinAIStatus | null): string => {
  switch (status?.state) {
    case 'ready':
      return 'ai_settings.provider_preset.gonavi_ai.signed_in';
    case 'login_expired':
      return 'ai_settings.provider_preset.gonavi_ai.state.login_expired';
    case 'network_error':
      return 'ai_settings.provider_preset.gonavi_ai.state.network_error';
    case 'service_unavailable':
      return 'ai_settings.provider_preset.gonavi_ai.state.service_unavailable';
    case 'quota_unavailable':
      return 'ai_settings.provider_preset.gonavi_ai.state.quota_unavailable';
    case 'not_configured':
      return 'ai_settings.provider_preset.gonavi_ai.gateway_unavailable';
    default:
      return 'ai_settings.provider_preset.gonavi_ai.sign_in_required';
  }
};

/** Opens the Gateway login page in the system browser (falls back to a new tab). */
export const openBuiltinAIVerificationURL = (url: string): void => {
  try {
    BrowserOpenURL(url);
  } catch {
    if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener,noreferrer');
  }
};
