import { useCallback, useEffect, useRef, useState } from 'react';
import type { TabData } from '../../types';
import type {
  ScriptDraft,
  ScriptDraftSnapshot,
  ScriptLibraryScript,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import {
  buildInitialDraft,
  draftFromScript,
  fillScriptDraftContext,
} from './scriptWorkbenchUtils';
import {
  clearScriptWorkbenchDraft,
  loadScriptWorkbenchDraft,
  saveScriptWorkbenchDraft,
  type ScriptDraftSaveResult,
  type ScriptDraftStorageFailure,
} from './scriptWorkbenchDraftStorage';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import { createScriptDraftInstanceId } from './scriptWorkbenchIds';

const storageErrorKey = (reason: ScriptDraftStorageFailure): string => {
  switch (reason) {
    case 'source_too_large':
      return 'script_workbench.error.draft_source_too_large';
    case 'quota':
      return 'script_workbench.error.draft_storage_quota';
    case 'unavailable':
      return 'script_workbench.error.draft_storage_unavailable';
    default:
      return 'script_workbench.error.operation_failed';
  }
};

export const useScriptWorkbenchDraft = ({
  adapter,
  tab,
  defaultName,
  defaultSource,
  connectionIds,
  connections,
  t,
  formatError,
}: {
  adapter: ScriptWorkbenchAdapter;
  tab: TabData;
  defaultName: string;
  defaultSource: string;
  connectionIds: readonly string[];
  connections: Parameters<typeof buildInitialDraft>[0]['connections'];
  t: ScriptWorkbenchTranslate;
  formatError?: (error: unknown) => string;
}) => {
  const [restoredDraft] = useState(() => loadScriptWorkbenchDraft(tab.id, tab.scriptId));
  const restoredDraftRef = useRef(Boolean(restoredDraft));
  const loadedScriptIdRef = useRef(restoredDraft?.id || '');
  const [draft, setDraft] = useState<ScriptDraft>(() => (
    restoredDraft
      ? { ...restoredDraft, draftInstanceId: createScriptDraftInstanceId() }
      : buildInitialDraft({
        tab,
        defaultName,
        source: defaultSource,
        connectionIds,
        connections,
      })
  ));
  const [dirty, setDirty] = useState(Boolean(restoredDraft) || Boolean(tab.scriptPreviewSource));
  const [loading, setLoading] = useState(Boolean(tab.scriptId) && !restoredDraft);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const epochRef = useRef(0);
  const contextInitializedRef = useRef(false);
  const autoAddConnectionsRef = useRef(true);
  const requestRef = useRef(0);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraftRef = useRef({ draft, dirty });
  latestDraftRef.current = { draft, dirty };
  const formatErrorRef = useRef(formatError);
  formatErrorRef.current = formatError;

  const bumpEpoch = useCallback((): number => {
    epochRef.current += 1;
    setEpoch(epochRef.current);
    return epochRef.current;
  }, []);

  const getSnapshot = useCallback((): ScriptDraftSnapshot => ({
    ...latestDraftRef.current,
    epoch: epochRef.current,
  }), []);

  const clearPersistedDraft = useCallback(() => {
    clearScriptWorkbenchDraft(tab.id);
    setStorageError('');
  }, [tab.id]);

  const persistDraft = useCallback((): ScriptDraftSaveResult => {
    if (!latestDraftRef.current.dirty) {
      return { ok: true, bytes: 0, entries: 0 };
    }
    const result = saveScriptWorkbenchDraft(tab.id, latestDraftRef.current.draft);
    if (!result.ok) {
      setStorageError(t(storageErrorKey(result.reason)));
    } else {
      setStorageError('');
    }
    return result;
  }, [t, tab.id]);

  const applyScript = useCallback((script: ScriptLibraryScript) => {
    const base = draftFromScript(script);
    const next = fillScriptDraftContext({
      draft: base,
      connectionId: tab.connectionId,
      dbName: tab.dbName,
      connections,
      allowAddConnection: !(script.visibility === 'shared' && base.connections.length === 0),
      allowBindMissingConnection: script.visibility !== 'shared' || base.connections.length <= 1,
    });
    contextInitializedRef.current = true;
    autoAddConnectionsRef.current = !(script.visibility === 'shared' && base.connections.length === 0);
    bumpEpoch();
    restoredDraftRef.current = false;
    loadedScriptIdRef.current = script.id;
    latestDraftRef.current = { draft: next, dirty: next !== base };
    setDraft(next);
    setDirty(next !== base);
    setError('');
    clearPersistedDraft();
  }, [bumpEpoch, clearPersistedDraft, connections, tab.connectionId, tab.dbName]);

  const openScript = useCallback(async (scriptId: string): Promise<ScriptLibraryScript | null> => {
    const requestId = requestRef.current + 1;
    const requestEpoch = epochRef.current;
    requestRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const script = await adapter.getScript(scriptId);
      if (requestRef.current === requestId && epochRef.current === requestEpoch) {
        applyScript(script);
      }
      return script;
    } catch (loadError) {
      if (requestRef.current === requestId && epochRef.current === requestEpoch) {
        setError(formatErrorRef.current?.(loadError)
          ?? (loadError instanceof Error ? loadError.message : String(loadError)));
      }
      return null;
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [adapter, applyScript]);

  const contextKey = [
    tab.id,
    tab.scriptId || '',
    tab.connectionId || '',
    tab.dbName || '',
  ].join('\u0000');

  useEffect(() => {
    const current = latestDraftRef.current;
    const next = fillScriptDraftContext({
      draft: current.draft,
      connectionId: tab.connectionId,
      dbName: tab.dbName,
      connections,
      allowAddConnection: !contextInitializedRef.current || autoAddConnectionsRef.current,
      allowBindMissingConnection: current.draft.visibility !== 'shared'
        || current.draft.connections.length <= 1,
    });
    contextInitializedRef.current = true;
    if (next === current.draft) return;
    bumpEpoch();
    latestDraftRef.current = { draft: next, dirty: true };
    setDraft(next);
    setDirty(true);
    if (next.id) loadedScriptIdRef.current = next.id;
  }, [bumpEpoch, contextKey, connections, tab.connectionId, tab.dbName]);

  useEffect(() => {
    if (!tab.scriptId || restoredDraftRef.current || loadedScriptIdRef.current === tab.scriptId) return;
    void openScript(tab.scriptId);
  }, [openScript, tab.scriptId]);

  useEffect(() => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (!dirty) {
      clearPersistedDraft();
      return undefined;
    }
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistDraft();
    }, 160);
    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [clearPersistedDraft, dirty, draft, persistDraft]);

  useEffect(() => () => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (latestDraftRef.current.dirty) persistDraft();
  }, [persistDraft]);

  const resetDraft = useCallback((overrides: Partial<ScriptDraft> = {}) => {
    const next = {
      ...buildInitialDraft({
        tab: {
          ...tab,
          scriptId: undefined,
          scriptFolderId: undefined,
          scriptVisibility: undefined,
          scriptPreviewSource: undefined,
        },
        defaultName,
        source: defaultSource,
        connectionIds,
        connections,
      }),
      ...overrides,
      draftInstanceId: createScriptDraftInstanceId(),
    };
    contextInitializedRef.current = false;
    autoAddConnectionsRef.current = true;
    bumpEpoch();
    restoredDraftRef.current = false;
    loadedScriptIdRef.current = '';
    latestDraftRef.current = { draft: next, dirty: false };
    setDraft(next);
    setDirty(false);
    setError('');
    clearPersistedDraft();
  }, [bumpEpoch, clearPersistedDraft, connectionIds, connections, defaultName, defaultSource, tab]);

  const updateDraft = useCallback((patch: Partial<ScriptDraft>) => {
    const next = { ...latestDraftRef.current.draft, ...patch };
    if (patch.connections !== undefined) {
      autoAddConnectionsRef.current = patch.connections.length > 0;
    }
    bumpEpoch();
    latestDraftRef.current = { draft: next, dirty: true };
    setDraft(next);
    setDirty(true);
  }, [bumpEpoch]);

  const updateSource = useCallback((source: string) => {
    const next = { ...latestDraftRef.current.draft, source };
    bumpEpoch();
    latestDraftRef.current = { draft: next, dirty: true };
    setDraft(next);
    setDirty(true);
  }, [bumpEpoch]);

  const applySavedIfCurrent = useCallback((
    script: ScriptLibraryScript,
    expectedEpoch: number,
    expectedDraftInstanceId: string,
  ): boolean => {
    if (
      epochRef.current !== expectedEpoch
      || latestDraftRef.current.draft.draftInstanceId !== expectedDraftInstanceId
    ) return false;
    const base = draftFromScript(script, latestDraftRef.current.draft.draftInstanceId);
    const next = fillScriptDraftContext({
      draft: base,
      connectionId: tab.connectionId,
      dbName: tab.dbName,
      connections,
      allowAddConnection: !(base.visibility === 'shared' && base.connections.length === 0),
      allowBindMissingConnection: base.visibility !== 'shared' || base.connections.length <= 1,
    });
    contextInitializedRef.current = true;
    autoAddConnectionsRef.current = !(base.visibility === 'shared' && base.connections.length === 0);
    bumpEpoch();
    restoredDraftRef.current = false;
    loadedScriptIdRef.current = script.id;
    latestDraftRef.current = { draft: next, dirty: next !== base };
    setDraft(next);
    setDirty(next !== base);
    setError('');
    clearPersistedDraft();
    return true;
  }, [bumpEpoch, clearPersistedDraft, connections, tab.connectionId, tab.dbName]);

  const mergeServerMetadata = useCallback((
    script: ScriptLibraryScript,
    options: {
      includeName?: boolean;
      expectedDraftInstanceId: string;
    },
  ) => {
    const current = latestDraftRef.current;
    if (current.draft.draftInstanceId !== options.expectedDraftInstanceId) return;
    if (current.draft.id && current.draft.id !== script.id) return;
    const includeName = options.includeName === true;
    const next: ScriptDraft = {
      ...current.draft,
      id: script.id,
      revision: script.revision,
      visibility: script.visibility,
      folderId: script.folderId,
      owner: script.owner,
      canEdit: script.canEdit,
      canShare: script.canShare,
      ...(includeName ? {
        name: script.name,
        description: script.description || '',
      } : {}),
    };
    bumpEpoch();
    loadedScriptIdRef.current = script.id;
    latestDraftRef.current = { draft: next, dirty: current.dirty };
    setDraft(next);
    if (!current.dirty) clearPersistedDraft();
  }, [bumpEpoch, clearPersistedDraft]);

  return {
    draft,
    dirty,
    epoch,
    getSnapshot,
    applySavedIfCurrent,
    mergeServerMetadata,
    loading,
    error,
    storageError,
    applyScript,
    openScript,
    resetDraft,
    updateDraft,
    updateSource,
    persistDraft,
    clearPersistedDraft,
  };
};
