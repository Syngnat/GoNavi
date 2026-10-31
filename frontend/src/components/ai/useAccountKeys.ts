import { useCallback, useState } from 'react';
import {
  invokeAccountCommand,
  parseAccountGroups,
  parseAccountKeys,
  parseAccountKeyID,
  parseCreatedAccountKey,
  type AccountGroupItem,
  type AccountKeyItem,
} from './aiPluginProviderAccountApi';

export interface AccountKeysView {
  state: 'loading' | 'ready' | 'error';
  items: AccountKeyItem[];
  message: string;
}

export const EMPTY_KEYS: AccountKeysView = { state: 'ready', items: [], message: '' };

export function useAccountKeys(isMounted: () => boolean) {
  const [keys, setKeys] = useState<AccountKeysView>(EMPTY_KEYS);
  const [groups, setGroups] = useState<AccountGroupItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [mutating, setMutating] = useState(false);

  const resetKeys = useCallback(() => {
    setKeys(EMPTY_KEYS);
    setGroups([]);
    setCreating(false);
    setMutating(false);
  }, []);

  // Silent reload keeps the rendered rows in place, so a write never blanks the list.
  const loadKeys = useCallback(async (pluginId: string, silent = false) => {
    if (!silent) setKeys({ state: 'loading', items: [], message: '' });
    const outcome = await invokeAccountCommand(pluginId, 'account.keys', parseAccountKeys);
    if (!isMounted()) return;
    if (outcome.kind === 'ok') setKeys({ state: 'ready', items: outcome.data, message: '' });
    else if (!silent) setKeys({ state: 'error', items: [], message: outcome.kind === 'error' ? outcome.message : '' });
  }, [isMounted]);

  const loadGroups = useCallback(async (pluginId: string) => {
    const outcome = await invokeAccountCommand(pluginId, 'account.groups', parseAccountGroups);
    if (!isMounted()) return;
    if (outcome.kind === 'ok') setGroups(outcome.data);
  }, [isMounted]);

  const createKey = useCallback(async (pluginId: string, name: string, groupId?: number) => {
    setCreating(true);
    const payload: Record<string, unknown> = { name };
    if (groupId && groupId > 0) payload.groupId = groupId;
    const outcome = await invokeAccountCommand(pluginId, 'account.createKey', parseCreatedAccountKey, payload);
    if (!isMounted()) return { ok: false, message: '' };
    setCreating(false);
    if (outcome.kind !== 'ok') {
      return { ok: false, message: outcome.kind === 'error' ? outcome.message : '' };
    }
    await loadKeys(pluginId, true);
    return { ok: true, message: '' };
  }, [isMounted, loadKeys]);

  // The updated row is patched in place from the submitted values; only the
  // panel's own view of the group is trusted for the chip label.
  const applyUpdatedKey = useCallback((id: string, name: string, groupId?: number) => {
    setKeys((current) => ({
      ...current,
      state: 'ready',
      items: current.items.map((item) => {
        if (item.id !== id) return item;
        if (groupId === undefined) return { ...item, name };
        const chosen = groupId > 0 ? groups.find((group) => group.id === String(groupId)) : undefined;
        return {
          ...item,
          name,
          groupId: groupId > 0 ? String(groupId) : '',
          groupName: groupId > 0 ? chosen?.name ?? item.groupName : '',
          rateMultiplier: groupId > 0 ? chosen?.rateMultiplier ?? item.rateMultiplier : undefined,
        };
      }),
    }));
  }, [groups]);

  const updateKey = useCallback(async (pluginId: string, id: string, name: string, groupId?: number) => {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) return { ok: false, message: '' };
    setMutating(true);
    const payload: Record<string, unknown> = { id: numericId, name };
    if (groupId !== undefined) payload.groupId = groupId;
    const outcome = await invokeAccountCommand(pluginId, 'account.updateKey', parseCreatedAccountKey, payload);
    if (!isMounted()) return { ok: false, message: '' };
    setMutating(false);
    if (outcome.kind !== 'ok') {
      return { ok: false, message: outcome.kind === 'error' ? outcome.message : '' };
    }
    applyUpdatedKey(id, name, groupId);
    return { ok: true, message: '' };
  }, [isMounted, applyUpdatedKey]);

  const deleteKey = useCallback(async (pluginId: string, id: string) => {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) return { ok: false, message: '' };
    setMutating(true);
    const outcome = await invokeAccountCommand(pluginId, 'account.deleteKey', parseAccountKeyID, { id: numericId });
    if (!isMounted()) return { ok: false, message: '' };
    setMutating(false);
    if (outcome.kind !== 'ok') {
      return { ok: false, message: outcome.kind === 'error' ? outcome.message : '' };
    }
    setKeys((current) => ({ ...current, state: 'ready', items: current.items.filter((item) => item.id !== id) }));
    return { ok: true, message: '' };
  }, [isMounted]);

  return { keys, groups, creating, mutating, loadKeys, loadGroups, createKey, updateKey, deleteKey, resetKeys };
}
