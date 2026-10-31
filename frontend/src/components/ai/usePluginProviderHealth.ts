import { useEffect, useState } from 'react';
import { invokeAccountCommand, parseAccountStatus } from './aiPluginProviderAccountApi';

export interface PluginProviderHealth {
  online: boolean;
  latencyMs: number | null;
}

export function usePluginProviderHealth(pluginId: string | undefined, available: boolean): PluginProviderHealth {
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    setLatencyMs(null);
    if (!pluginId || !available) return undefined;
    const started = performance.now();
    let alive = true;
    void invokeAccountCommand(pluginId, 'account.status', parseAccountStatus).then(() => {
      if (alive) setLatencyMs(Math.max(0, Math.round(performance.now() - started)));
    });
    return () => { alive = false; };
  }, [pluginId, available]);

  return { online: available, latencyMs: available ? latencyMs : null };
}
