import { useCallback, useRef, useState } from 'react';

// Keep the optimistic snapshot synchronous so overlapping lifecycle actions see
// the latest revocation even before React commits the next render.
export function usePluginRevocation() {
  const current = useRef(new Set<string>());
  const [revoked, setRevoked] = useState(current.current);
  const isRevoked = useCallback((id: string) => current.current.has(id), []);
  const revoke = useCallback((id: string, value: boolean) => {
    const next = new Set(current.current);
    if (value) next.add(id); else next.delete(id);
    current.current = next;
    setRevoked(next);
  }, []);
  return { revoked, isRevoked, revoke };
}
