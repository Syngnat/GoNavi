import { useCallback, useState } from 'react';
import {
  invokeAccountCommand,
  parseAccountStatus,
  type AccountStatus,
} from './aiPluginProviderAccountApi';

export const EMPTY_STATUS: AccountStatus = {
  state: 'signed_out',
  reason: '',
  email: '',
  userId: '',
  status: '',
  expiresAt: '',
};

export interface AccountStatusState {
  visible: boolean;
  pending: boolean;
  status: AccountStatus | null;
  error: string;
  reset: () => void;
  setError: (message: string) => void;
  markSignedOut: () => void;
  // Probe answers whether the plugin supports account commands at all; false hides the block.
  probe: (pluginId: string) => Promise<AccountStatus | null>;
  loadStatus: (pluginId: string) => Promise<AccountStatus | null>;
}

interface AccountStatusOptions {
  isMounted: () => boolean;
  onReady?: (pluginId: string) => void;
}

export function useAccountStatus({ isMounted, onReady }: AccountStatusOptions): AccountStatusState {
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(true);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [error, setError] = useState('');

  const reset = useCallback(() => {
    setVisible(false);
    setPending(true);
    setStatus(null);
    setError('');
  }, []);

  const markSignedOut = useCallback(() => {
    setStatus((current) => ({ ...(current ?? EMPTY_STATUS), state: 'signed_out' }));
  }, []);

  const probe = useCallback(async (pluginId: string) => {
    const outcome = await invokeAccountCommand(pluginId, 'account.status', parseAccountStatus);
    if (!isMounted()) return null;
    if (outcome.kind !== 'ok') {
      setVisible(false);
      setPending(false);
      setStatus(null);
      setError('');
      return null;
    }
    setVisible(true);
    setPending(false);
    setStatus(outcome.data);
    setError('');
    if (outcome.data.state === 'ready') onReady?.(pluginId);
    return outcome.data;
  }, [isMounted, onReady]);

  const loadStatus = useCallback(async (pluginId: string) => {
    const outcome = await invokeAccountCommand(pluginId, 'account.status', parseAccountStatus);
    if (!isMounted()) return null;
    if (outcome.kind !== 'ok') {
      setError(outcome.kind === 'error' ? outcome.message : '');
      return null;
    }
    setVisible(true);
    setStatus(outcome.data);
    setError('');
    return outcome.data;
  }, [isMounted]);

  return { visible, pending, status, error, reset, setError, markSignedOut, probe, loadStatus };
}
