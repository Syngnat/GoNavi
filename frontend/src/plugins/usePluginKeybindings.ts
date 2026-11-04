import { useCallback, useEffect, useState } from 'react';
import { pluginAPI } from './api';
import { matchPluginKeybinding, parsePluginKeybinding, type GonaviKeybindingMatcher } from './keybindings';
import type { PluginKeybinding, PluginStatus } from './types';
import { openPluginPageTab } from '../pluginPages/openPluginPageTab';
import { useStore } from '../store';

interface KeybindingEntry {
  pluginID: string;
  binding: PluginKeybinding;
  matcher: GonaviKeybindingMatcher;
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element || !element.tagName) return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
};

const running = (plugin: PluginStatus) =>
  plugin.desiredEnabled && plugin.state === 'running' && (plugin.manifest.contributes?.keybindings?.length ?? 0) > 0;

/**
 * Registers host-wide shortcuts declared by running plugins. Host shortcuts run
 * first: this listener never consumes keys while focus is in an editable field,
 * and plugins are expected to avoid combinations the host already uses.
 */
export function usePluginKeybindings(): void {
  const language = useStore((state) => state.languagePreference);
  const theme = useStore((state) => state.theme);
  const [entries, setEntries] = useState<KeybindingEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [items, runtime] = await Promise.all([pluginAPI.list(), pluginAPI.runtimeInfo()]);
      if (runtime.safeMode || !runtime.managementAllowed) {
        setEntries([]);
        return;
      }
      const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
      const claimed = new Set<string>();
      const next: KeybindingEntry[] = [];
      for (const plugin of items.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))) {
        if (!running(plugin)) continue;
        for (const binding of plugin.manifest.contributes?.keybindings ?? []) {
          const matcher = parsePluginKeybinding(binding.keys, isMac);
          if (!matcher) continue;
          const key = [matcher.key, matcher.ctrl, matcher.meta, matcher.shift, matcher.alt].join(':');
          if (claimed.has(key)) continue;
          claimed.add(key);
          next.push({ pluginID: plugin.manifest.id, binding, matcher });
        }
      }
      setEntries(next);
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (typeof window === 'undefined') return undefined;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  useEffect(() => {
    if (typeof window === 'undefined' || entries.length === 0) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      for (const entry of entries) {
        if (!matchPluginKeybinding(event, entry.matcher)) continue;
        event.preventDefault();
        const target = entry.binding.target;
        if ((target.type ?? 'page') === 'window') {
          void pluginAPI.openWindow(entry.pluginID, language, theme);
        } else if (target.page) {
          openPluginPageTab({ pluginID: entry.pluginID, pageID: target.page, title: entry.binding.title });
        }
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [entries, language, theme]);
}
