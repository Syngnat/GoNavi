import { useCallback, useEffect, useState } from 'react';
import { pluginAPI } from '../plugins/api';

// Local installed versions power the market's update badges. A listing failure
// leaves the market browsing anonymous instead of blocking it.
export function useInstalledPluginVersions(revision: number) {
  const [installed, setInstalled] = useState<Map<string, string>>(new Map());
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let alive = true;
    pluginAPI.list()
      .then((items) => {
        if (!alive) return;
        setInstalled(new Map(items.map((item) => [item.manifest.id, item.manifest.version])));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [revision, epoch]);
  const refresh = useCallback(() => { setEpoch((value) => value + 1); }, []);
  return { installed, refresh };
}
