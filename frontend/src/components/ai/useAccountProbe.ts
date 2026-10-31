import { useEffect, useRef } from 'react';
import type { AccountStatus } from './aiPluginProviderAccountApi';

// Probes once per plugin id so remounts and re-renders never flood the host.
export function useAccountProbe(
  pluginId: string | undefined,
  probe: (pluginId: string) => Promise<AccountStatus | null>,
  reset: () => void,
) {
  const probedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!pluginId) {
      probedId.current = undefined;
      reset();
      return undefined;
    }
    if (probedId.current === pluginId) return undefined;
    probedId.current = pluginId;
    // A different plugin id must not show the previous plugin's account state.
    reset();
    void probe(pluginId);
    return undefined;
  }, [pluginId, probe, reset]);
}
