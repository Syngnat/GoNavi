import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ScriptLibrarySnapshot,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import { scriptWorkbenchErrorKey } from './scriptWorkbenchErrors';

export const useScriptLibrary = (
  adapter: ScriptWorkbenchAdapter,
  formatError?: (error: unknown) => string,
) => {
  const [snapshot, setSnapshot] = useState<ScriptLibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const requestIdRef = useRef(0);
  const formatErrorRef = useRef(formatError);
  formatErrorRef.current = formatError;

  const refresh = useCallback(async (): Promise<ScriptLibrarySnapshot | null> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const next = await adapter.listLibrary();
      if (requestIdRef.current === requestId) {
        setSnapshot(next);
        return next;
      }
    } catch (loadError) {
      if (requestIdRef.current === requestId) {
        setError(formatErrorRef.current?.(loadError)
          ?? (loadError instanceof Error ? loadError.message : String(loadError)));
        const code = String((loadError as { code?: unknown })?.code || '');
        const mappedKey = scriptWorkbenchErrorKey(loadError);
        setErrorCode(
          code || (mappedKey === 'script_workbench.error.forbidden' ? 'forbidden' : ''),
        );
      }
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
    return null;
  }, [adapter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    snapshot,
    loading,
    error,
    errorCode,
    refresh,
  };
};
