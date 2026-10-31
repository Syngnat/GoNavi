import { useCallback, useEffect, useRef, useState } from 'react';
import { invokeAccountCommand, parseAccountStarted, parseAccountStatus, type AccountStatus } from './aiPluginProviderAccountApi';
import { useAccountKeys, type AccountKeysView } from './useAccountKeys';
import { useAccountPolling } from './useAccountPolling';
import { useAccountProbe } from './useAccountProbe';
import { useAccountStatus } from './useAccountStatus';

export type { AccountKeysView };

export interface PluginProviderAccountController {
  visible: boolean;
  pending: boolean;
  status: AccountStatus | null;
  keys: AccountKeysView;
  groups: ReturnType<typeof useAccountKeys>['groups'];
  creating: boolean;
  mutating: boolean;
  signedOut: boolean;
  polling: boolean;
  busy: boolean;
  refreshing: boolean;
  timedOut: boolean;
  error: string;
  onLogin: () => void;
  onRefresh: () => void;
  onLogout: () => void;
  onOpenCreate: () => void;
  onCreateKey: (name: string, groupId?: number) => Promise<{ ok: boolean; message: string }>;
  onUpdateKey: (id: string, name: string, groupId?: number) => Promise<{ ok: boolean; message: string }>;
  onDeleteKey: (id: string) => Promise<{ ok: boolean; message: string }>;
}

export function usePluginProviderAccount(pluginId: string | undefined): PluginProviderAccountController {
  const [polling, setPolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const mounted = useRef(true);
  const isMounted = useCallback(() => mounted.current, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { keys, groups, creating, mutating, loadKeys, loadGroups, createKey, updateKey, deleteKey, resetKeys } = useAccountKeys(isMounted);
  const onKeysReady = useCallback((id: string) => {
    void loadKeys(id);
    void loadGroups(id);
  }, [loadKeys, loadGroups]);
  const { visible, pending, status, error, reset, setError, markSignedOut, probe, loadStatus } =
    useAccountStatus({ isMounted, onReady: onKeysReady });
  const resetAll = useCallback(() => {
    reset();
    resetKeys();
  }, [reset, resetKeys]);
  useAccountProbe(pluginId, probe, resetAll);

  const onPollReady = useCallback(async () => {
    setPolling(false);
    setTimedOut(false);
    if (!pluginId) return;
    const next = await loadStatus(pluginId);
    if (next?.state === 'ready') {
      await loadKeys(pluginId);
      await loadGroups(pluginId);
    }
  }, [pluginId, loadStatus, loadKeys, loadGroups]);

  const onPollTimeout = useCallback(() => {
    setPolling(false);
    setTimedOut(true);
  }, []);

  useAccountPolling({ pluginId, enabled: polling, onReady: onPollReady, onTimeout: onPollTimeout });

  const onLogin = useCallback(() => {
    if (!pluginId || busy) return;
    void (async () => {
      setBusy(true);
      setError('');
      setTimedOut(false);
      const outcome = await invokeAccountCommand(pluginId, 'account.login', parseAccountStarted);
      if (!mounted.current) return;
      setBusy(false);
      if (outcome.kind === 'ok') setPolling(true);
      else setError(outcome.kind === 'error' ? outcome.message : '');
    })();
  }, [pluginId, busy, setError]);

  const onRefresh = useCallback(() => {
    if (!pluginId || refreshing) return;
    void (async () => {
      setRefreshing(true);
      const next = await loadStatus(pluginId);
      if (next?.state === 'ready') {
        await loadKeys(pluginId);
        await loadGroups(pluginId);
      }
      if (mounted.current) setRefreshing(false);
    })();
  }, [pluginId, refreshing, loadStatus, loadKeys, loadGroups]);

  const onLogout = useCallback(() => {
    if (!pluginId || busy) return;
    void (async () => {
      setBusy(true);
      setPolling(false);
      setTimedOut(false);
      const outcome = await invokeAccountCommand(pluginId, 'account.logout', parseAccountStatus);
      if (!mounted.current) return;
      setBusy(false);
      if (outcome.kind !== 'ok') {
        setError(outcome.kind === 'error' ? outcome.message : '');
        return;
      }
      markSignedOut();
      resetKeys();
      setError('');
    })();
  }, [pluginId, busy, markSignedOut, resetKeys, setError]);

  const onOpenCreate = useCallback(() => {
    if (pluginId) void loadGroups(pluginId);
  }, [pluginId, loadGroups]);

  const onCreateKey = useCallback(async (name: string, groupId?: number) => {
    if (!pluginId) return { ok: false, message: '' };
    return createKey(pluginId, name, groupId);
  }, [pluginId, createKey]);

  const onUpdateKey = useCallback(async (id: string, name: string, groupId?: number) => {
    if (!pluginId) return { ok: false, message: '' };
    return updateKey(pluginId, id, name, groupId);
  }, [pluginId, updateKey]);

  const onDeleteKey = useCallback(async (id: string) => {
    if (!pluginId) return { ok: false, message: '' };
    return deleteKey(pluginId, id);
  }, [pluginId, deleteKey]);

  return {
    visible,
    pending,
    status,
    keys,
    groups,
    creating,
    mutating,
    signedOut: status?.state !== 'ready',
    polling,
    busy,
    refreshing,
    timedOut,
    error,
    onLogin,
    onRefresh,
    onLogout,
    onOpenCreate,
    onCreateKey,
    onUpdateKey,
    onDeleteKey,
  };
}
