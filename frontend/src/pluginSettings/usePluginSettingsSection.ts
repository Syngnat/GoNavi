import { useEffect, useState } from 'react';
import { pluginAPI } from '../plugins/api';
import { PLUGIN_LIFECYCLE_EVENT } from '../plugins/events';
import type { PluginSettingsSection, PluginStatus } from '../plugins/types';

export interface PluginSettingsSectionTarget {
  pluginID: string;
  sectionID: string;
  pageID: string;
}

const runningSections = (status: PluginStatus): PluginSettingsSection[] => (
  status.desiredEnabled && status.state === 'running' && !status.manifestDegraded
    ? status.manifest.contributes?.settingsSections ?? []
    : []
);

/**
 * Resolves the enabled plugin that provides one host-owned settings slot.
 *
 * The settings center mounts long before a user installs the plugin (and keeps
 * the tab alive afterwards), so the lookup refreshes on the package lifecycle
 * event instead of relying on a mount-time snapshot.
 */
export function usePluginSettingsSection(slot: PluginSettingsSection['slot']): {
  target: PluginSettingsSectionTarget | null;
  loading: boolean;
} {
  const [target, setTarget] = useState<PluginSettingsSectionTarget | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const statuses = await pluginAPI.list();
        if (!alive) return;
        const candidates = statuses.flatMap((status) => runningSections(status)
          .filter((section) => section.slot === slot)
          .map((section) => ({ status, section })))
          .sort((left, right) => (
            (left.section.order ?? 0) - (right.section.order ?? 0)
            || left.status.manifest.id.localeCompare(right.status.manifest.id)
          ));
        const first = candidates[0];
        setTarget(first
          ? { pluginID: first.status.manifest.id, sectionID: first.section.id, pageID: first.section.page }
          : null);
      } catch {
        if (alive) setTarget(null);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void refresh();
    const handleLifecycle = () => { void refresh(); };
    window.addEventListener(PLUGIN_LIFECYCLE_EVENT, handleLifecycle);
    return () => {
      alive = false;
      window.removeEventListener(PLUGIN_LIFECYCLE_EVENT, handleLifecycle);
    };
  }, [slot]);

  return { target, loading };
}
