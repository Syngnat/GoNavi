import { useEffect } from 'react';
import { invokeAccountCommand, parseAccountPoll } from './aiPluginProviderAccountApi';

export const ACCOUNT_POLL_INTERVAL_MS = 2000;
// 150 attempts at 2s each is the 5 minute upper bound from the login contract.
export const ACCOUNT_POLL_MAX_ATTEMPTS = 150;

interface AccountPollingOptions {
  pluginId?: string;
  enabled: boolean;
  onReady: () => Promise<void>;
  onTimeout: () => void;
}

export function useAccountPolling({ pluginId, enabled, onReady, onTimeout }: AccountPollingOptions) {
  useEffect(() => {
    if (!enabled || !pluginId) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      attempts += 1;
      const outcome = await invokeAccountCommand(pluginId, 'account.poll', parseAccountPoll);
      if (cancelled) return;
      if (outcome.kind === 'ok' && outcome.data.state === 'ready') {
        await onReady();
        return;
      }
      if (attempts >= ACCOUNT_POLL_MAX_ATTEMPTS) {
        onTimeout();
        return;
      }
      timer = setTimeout(() => void tick(), ACCOUNT_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), ACCOUNT_POLL_INTERVAL_MS);
    // The cleanup clears the pending timer, so an unmounted panel stops polling.
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pluginId, enabled, onReady, onTimeout]);
}
