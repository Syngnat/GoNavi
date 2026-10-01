import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clearSessionAutoApprovals,
  readAutoApprovalSettings,
  setGlobalAutoApproval,
  type AIAutoApprovalSettings,
} from './aiAutoApproval';

export interface AIAutoApprovalSettingsState {
  /** Null until the first read finishes, or when the Go service is unreachable. */
  settings: AIAutoApprovalSettings | null;
  loading: boolean;
  busy: boolean;
  failed: boolean;
  setGlobal: (enabled: boolean) => Promise<void>;
  clearSessions: () => Promise<void>;
}

export const useAIAutoApprovalSettings = (): AIAutoApprovalSettingsState => {
  const [settings, setSettings] = useState<AIAutoApprovalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void readAutoApprovalSettings()
      .then((value) => { if (mountedRef.current) setSettings(value); })
      .catch(() => { if (mountedRef.current) setFailed(true); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
    return () => { mountedRef.current = false; };
  }, []);

  const apply = useCallback(async (action: () => Promise<AIAutoApprovalSettings>) => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await action();
      if (mountedRef.current) setSettings(next);
    } catch {
      if (mountedRef.current) setFailed(true);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  return {
    settings,
    loading,
    busy,
    failed,
    setGlobal: (enabled) => apply(() => setGlobalAutoApproval(enabled)),
    clearSessions: () => apply(clearSessionAutoApprovals),
  };
};
