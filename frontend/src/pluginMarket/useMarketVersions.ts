import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pluginErrorText } from '../plugins/apiResult';
import { loadMarketVersions, type MarketVersionChoice } from './versionsApi';
import { orderVersionChoices, recommendedMarketVersion } from './versionChoices';
export function useMarketVersions(id: string, sourceId: string | undefined, scoped: boolean, enabled: boolean, preferredVersion?: string) {
 const [versions, setVersions] = useState<MarketVersionChoice[]>([]);
 const [selectedVersion, setSelectedVersion] = useState<string>();
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState('');
 const [warning, setWarning] = useState('');
 const epoch = useRef(0);
 const reload = useCallback(async () => {
  if (!enabled || !sourceId) return;
  const ticket = ++epoch.current; setLoading(true); setError('');
  try {
   const page = await loadMarketVersions(id, sourceId, scoped);
   if (ticket !== epoch.current) return;
   const choices = orderVersionChoices(page.versions); setVersions(choices); setWarning(page.warning ?? '');
   setSelectedVersion((previous) => choices.some((choice) => choice.compatible && choice.plugin.version === previous) ? previous
      : choices.some((choice) => choice.compatible && choice.plugin.version === preferredVersion) ? preferredVersion : recommendedMarketVersion(choices));
  } catch (cause) { if (ticket === epoch.current) setError(pluginErrorText(cause)); }
  finally { if (ticket === epoch.current) setLoading(false); }
 }, [id, sourceId, scoped, enabled, preferredVersion]);
 useEffect(() => { setVersions([]); setSelectedVersion(undefined); setWarning(''); setError(''); void reload(); return () => { epoch.current++; }; }, [reload]);
 const selected = useMemo(() => versions.find((choice) => choice.plugin.version === selectedVersion), [versions, selectedVersion]);
 const choose = (version: string) => { if (versions.some((choice) => choice.compatible && choice.plugin.version === version)) setSelectedVersion(version); };
 return { versions, selected, selectedVersion, recommended: recommendedMarketVersion(versions), loading, error, warning, choose, reload };
}
