import { useCallback, useRef } from 'react';
import { useStore } from '../../store';
import type { TabData } from '../../types';
import type {
  SaveScriptInput,
  ScriptDraft,
  ScriptDraftSnapshot,
  ScriptLibraryScript,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import { ScriptWorkbenchRequestError } from './scriptWorkbenchErrors';
import {
  buildScriptDraftFingerprint,
  sameScriptDraftFingerprint,
} from './scriptWorkbenchUtils';
import { scriptDraftAliasErrorKey } from './scriptWorkbenchValidation';

const MAX_SAVE_ATTEMPTS = 3;

const saveInputFromDraft = (draft: ScriptDraft): SaveScriptInput => ({
  id: draft.id,
  name: draft.name.trim(),
  description: draft.description,
  code: draft.source,
  visibility: draft.visibility,
  folderId: draft.folderId,
  connections: draft.connections,
  inputs: draft.inputs,
  allowWrite: draft.allowWrite,
  batchSize: draft.batchSize,
  inListLimit: draft.inListLimit,
  ...(draft.runLimits ? { runLimits: draft.runLimits } : {}),
  revision: draft.revision,
});

export const useScriptWorkbenchPersistence = ({
  adapter,
  tab,
  t,
  getSnapshot,
  applySavedIfCurrent,
  mergeServerMetadata,
  refreshLibrary,
}: {
  adapter: ScriptWorkbenchAdapter;
  tab: TabData;
  t: ScriptWorkbenchTranslate;
  getSnapshot: () => ScriptDraftSnapshot;
  applySavedIfCurrent: (
    script: ScriptLibraryScript,
    expectedEpoch: number,
    expectedDraftInstanceId: string,
  ) => boolean;
  mergeServerMetadata: (
    script: ScriptLibraryScript,
    options: { includeName?: boolean; expectedDraftInstanceId: string },
  ) => void;
  refreshLibrary: () => Promise<unknown>;
}) => {
  const syncLibraryScript = useCallback((
    script: ScriptLibraryScript,
    expectedDraftInstanceId: string,
  ) => {
    if (getSnapshot().draft.draftInstanceId !== expectedDraftInstanceId) return false;
    useStore.setState((state) => ({
      tabs: state.tabs.map((candidate) => (
        candidate.id === tab.id
          ? {
            ...candidate,
            title: script.name,
            scriptId: script.id,
            scriptFolderId: script.folderId,
            scriptVisibility: script.visibility,
            scriptDisplayName: script.name,
            scriptPreviewSource: undefined,
          }
          : candidate
      )),
    }));
    return true;
  }, [getSnapshot, tab.id]);

  const draftChangedError = useCallback(() => new ScriptWorkbenchRequestError(
    t('script_workbench.error.draft_changed'),
    'draft_changed',
  ), [t]);

  const saveInFlightRef = useRef<Promise<ScriptLibraryScript> | null>(null);
  const save = useCallback((): Promise<ScriptLibraryScript> => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const operation = (async () => {
      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
        const snapshot = getSnapshot();
        const draftInstanceId = snapshot.draft.draftInstanceId;
        const submittedFingerprint = buildScriptDraftFingerprint(snapshot.draft);
        const aliasErrorKey = scriptDraftAliasErrorKey(
          snapshot.draft.connections,
          snapshot.draft.inputs,
        );
        if (aliasErrorKey) {
          throw new ScriptWorkbenchRequestError(t(aliasErrorKey), 'invalid_input');
        }
        const name = snapshot.draft.name.trim();
        if (!name) {
          throw new ScriptWorkbenchRequestError(
            t('script_workbench.error.empty_name'),
            'empty_name',
          );
        }
        const saved = await adapter.saveScript(saveInputFromDraft({
          ...snapshot.draft,
          name,
        }));
        const currentAfterSave = getSnapshot();
        const responseMatches = currentAfterSave.epoch === snapshot.epoch
          && currentAfterSave.draft.draftInstanceId === draftInstanceId
          && currentAfterSave.draft.id === snapshot.draft.id
          && sameScriptDraftFingerprint(
            submittedFingerprint,
            buildScriptDraftFingerprint(currentAfterSave.draft),
          );
        if (responseMatches && applySavedIfCurrent(saved, snapshot.epoch, draftInstanceId)) {
          syncLibraryScript(saved, draftInstanceId);
          await refreshLibrary().catch(() => undefined);
          return saved;
        }

        const latestBeforeMerge = getSnapshot();
        if (latestBeforeMerge.draft.id !== snapshot.draft.id) {
          throw draftChangedError();
        }
        mergeServerMetadata(saved, {
          includeName: false,
          expectedDraftInstanceId: draftInstanceId,
        });
        const latest = getSnapshot();
        if (
          latest.draft.draftInstanceId !== draftInstanceId
          || latest.draft.id !== saved.id
        ) {
          throw draftChangedError();
        }
        syncLibraryScript({
          ...saved,
          name: latest.draft.name,
          visibility: latest.draft.visibility,
          folderId: latest.draft.folderId,
        }, draftInstanceId);
      }
      throw draftChangedError();
    })();
    saveInFlightRef.current = operation;
    void operation.finally(() => {
      if (saveInFlightRef.current === operation) saveInFlightRef.current = null;
    }).catch(() => undefined);
    return operation;
  }, [
    adapter,
    applySavedIfCurrent,
    draftChangedError,
    getSnapshot,
    mergeServerMetadata,
    refreshLibrary,
    syncLibraryScript,
    t,
  ]);

  const share = useCallback(async (): Promise<ScriptLibraryScript | null> => {
    let snapshot = getSnapshot();
    if (snapshot.dirty || !snapshot.draft.id) {
      await save();
      snapshot = getSnapshot();
    }
    const targetId = String(snapshot.draft.id || '').trim();
    if (!targetId) {
      throw new ScriptWorkbenchRequestError(
        t('script_workbench.error.invalid_input'),
        'invalid_input',
      );
    }
    const targetEpoch = snapshot.epoch;
    const targetDraftInstanceId = snapshot.draft.draftInstanceId;
    const shared = await adapter.shareScript({
      id: targetId,
      revision: snapshot.draft.revision,
      visibility: snapshot.draft.visibility === 'shared' ? 'private' : 'shared',
    });
    const latest = getSnapshot();
    if (
      latest.draft.draftInstanceId !== targetDraftInstanceId
      || latest.draft.id !== targetId
    ) {
      await refreshLibrary().catch(() => undefined);
      return shared;
    }
    if (!applySavedIfCurrent(shared, targetEpoch, targetDraftInstanceId)) {
      mergeServerMetadata(shared, {
        includeName: false,
        expectedDraftInstanceId: targetDraftInstanceId,
      });
      const merged = getSnapshot();
      syncLibraryScript({
        ...shared,
        name: merged.draft.name,
        visibility: merged.draft.visibility,
        folderId: merged.draft.folderId,
      }, targetDraftInstanceId);
    } else {
      syncLibraryScript(shared, targetDraftInstanceId);
    }
    await refreshLibrary().catch(() => undefined);
    return shared;
  }, [
    adapter,
    applySavedIfCurrent,
    getSnapshot,
    mergeServerMetadata,
    refreshLibrary,
    save,
    syncLibraryScript,
    t,
  ]);

  return {
    save,
    share,
    syncLibraryScript,
  };
};
