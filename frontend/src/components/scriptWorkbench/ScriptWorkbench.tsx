import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';
import { useStore } from '../../store';
import type { ScriptWorkbenchProps, ScriptLibraryScript } from './scriptWorkbenchTypes';
import {
  createScriptWorkbenchBackendAdapter,
} from './scriptWorkbenchBackendAdapter';
import { useScriptLibrary } from './useScriptLibrary';
import { useScriptRunSession } from './useScriptRunSession';
import { useScriptWorkbenchCopy } from './useScriptWorkbenchCopy';
import { useScriptWorkbenchDraft } from './useScriptWorkbenchDraft';
import { useScriptInputSheets } from './useScriptInputSheets';
import { useScriptWorkbenchPersistence } from './useScriptWorkbenchPersistence';
import {
  SCRIPT_STARTER_SOURCE,
  buildScriptAiPrompt,
  buildScriptDraftFingerprint,
  describeConnectionEnvironment,
  inputBindingKey,
  inputDisplayName,
  isXlsxInput,
  resolveDraftRunLimits,
  resolveRunLimitsForRequest,
  resolveScriptConnectionDatabase,
  resolveScriptRunLimitBounds,
  sameScriptDraftFingerprint,
  scriptFromDraft,
  scriptSourceWithPrimaryAlias,
} from './scriptWorkbenchUtils';
import { confirmScriptWriteRisks } from './scriptWorkbenchRisk';
import { ScriptWorkbenchHeader } from './ScriptWorkbenchHeader';
import { ScriptWorkbenchContextBar } from './ScriptWorkbenchContextBar';
import { ScriptWorkbenchSettings } from './ScriptWorkbenchSettings';
import { ScriptWorkbenchEditor } from './ScriptWorkbenchEditor';
import { ScriptWorkbenchResults } from './ScriptWorkbenchResults';
import { ScriptLibraryDialog } from './ScriptLibraryDialog';
import { ScriptWorkbenchWriteDialog, type ScriptWriteTarget } from './ScriptWorkbenchWriteDialog';
import { ScriptWorkbenchConfirmDialog } from './ScriptWorkbenchConfirmDialog';
import { registerWorkbenchTabCloseGuard } from '../../utils/workbenchTabCloseProtection';
import {
  ScriptWorkbenchRequestError,
  formatScriptWorkbenchError,
} from './scriptWorkbenchErrors';
import {
  scriptDraftAliasErrorKey,
  uniqueScriptAlias,
} from './scriptWorkbenchValidation';
import {
  canEditScriptItem,
  canShareScriptItem,
} from './scriptWorkbenchPermissions';
import { useDismissibleError } from './useDismissibleError';
import './scriptWorkbench.css';
import './scriptWorkbenchDialogs.css';

const ScriptWorkbench: React.FC<ScriptWorkbenchProps> = ({
  tab,
  isActive = true,
  adapter: adapterOverride,
}) => {
  const t = useScriptWorkbenchCopy();
  const connections = useStore((state) => state.connections);
  const translateRef = useRef(t);
  translateRef.current = t;
  const backendAdapter = useMemo(
    () => createScriptWorkbenchBackendAdapter((key, params) => translateRef.current(key, params)),
    [],
  );
  const adapter = adapterOverride || backendAdapter;
  const defaultName = tab.scriptDisplayName || t('script_workbench.default_name');
  const [connectionIds, setConnectionIds] = useState<string[]>(
    tab.connectionId ? [tab.connectionId] : [],
  );
  const formatError = useCallback(
    (requestError: unknown) => formatScriptWorkbenchError(requestError, t),
    [t],
  );
  const library = useScriptLibrary(adapter, formatError);
  const draftState = useScriptWorkbenchDraft({
    adapter,
    tab,
    defaultName,
    defaultSource: SCRIPT_STARTER_SOURCE,
    connectionIds,
    connections,
    t,
    formatError,
  });
  const { draft } = draftState;
  const draftRunLimits = useMemo(
    () => resolveDraftRunLimits(draft),
    [draft.runLimits],
  );
  const runLimitBounds = useMemo(() => resolveScriptRunLimitBounds(), []);
  const inputSheets = useScriptInputSheets({
    adapter,
    inputs: draft.inputs,
    formatError,
  });
  const aliasErrorKey = scriptDraftAliasErrorKey(draft.connections, draft.inputs);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [writeConfirmOpen, setWriteConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [pendingScript, setPendingScript] = useState<ScriptLibraryScript | null>(null);
  const [error, setError] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const shareBusyRef = useRef(false);
  const run = useScriptRunSession(adapter, setError, formatError);
  const localError = useDismissibleError(error);
  const draftError = useDismissibleError(draftState.error);
  const storageError = useDismissibleError(draftState.storageError);
  const libraryError = useDismissibleError(library.error);
  const persistence = useScriptWorkbenchPersistence({
    adapter,
    tab,
    t,
    getSnapshot: draftState.getSnapshot,
    applySavedIfCurrent: draftState.applySavedIfCurrent,
    mergeServerMetadata: draftState.mergeServerMetadata,
    refreshLibrary: library.refresh,
  });
  const currentLibraryScript = draft.id
    ? library.snapshot?.scripts.find((script) => script.id === draft.id)
    : undefined;
  const canEditCurrent = draft.id
    ? canEditScriptItem(library.snapshot, currentLibraryScript || scriptFromDraft(draft))
    : library.snapshot?.canWrite === true;
  const canShareCurrent = draft.id
    ? canShareScriptItem(library.snapshot, currentLibraryScript || scriptFromDraft(draft))
    : library.snapshot?.canShare === true && canEditCurrent;
  const writeTargets: ScriptWriteTarget[] = useMemo(
    () => draft.connections.map((binding) => {
      const connection = connections.find((candidate) => candidate.id === binding.connectionId);
      return {
        alias: binding.alias,
        connectionName: connection?.name || binding.alias,
        database: binding.database || resolveScriptConnectionDatabase(connection),
        environment: describeConnectionEnvironment(connection),
      };
    }),
    [connections, draft.connections],
  );
  const isRunning = run.status === 'preparing' || run.status === 'running' || run.status === 'cancelling';
  const allowWriteEnabled = canEditCurrent;
  const draftConnectionSignature = draft.connections
    .map((binding) => binding.connectionId || '')
    .filter(Boolean)
    .join('\u0000');
  const authorizationAbortRef = useRef<AbortController | null>(null);
  const allowWriteEnabledRef = useRef(allowWriteEnabled);
  allowWriteEnabledRef.current = allowWriteEnabled;

  useEffect(() => {
    const nextInputs = draft.inputs.map((input) => {
      if (!isXlsxInput(input) || input.sheetName) return input;
      const firstSheet = inputSheets.states[inputBindingKey(input)]?.sheets?.[0];
      return firstSheet ? { ...input, sheetName: firstSheet } : input;
    });
    if (nextInputs.every((input, index) => input === draft.inputs[index])) return;
    draftState.updateDraft({ inputs: nextInputs });
  }, [draft.inputs, draftState, inputSheets.states]);

  useEffect(() => {
    authorizationAbortRef.current?.abort();
  }, [
    draftState.epoch,
    tab.connectionId,
    tab.dbName,
    tab.id,
    tab.scriptId,
  ]);

  useEffect(() => () => {
    authorizationAbortRef.current?.abort();
  }, []);

  useEffect(() => () => {
    if (!adapterOverride) backendAdapter.dispose?.();
  }, [adapterOverride, backendAdapter]);

  useEffect(() => registerWorkbenchTabCloseGuard(tab.id, {
    isDirty: () => draftState.dirty,
    isRunning: () => isRunning,
    save: async () => {
      if (aliasErrorKey || !canEditCurrent) return false;
      try {
        await persistence.save();
        return true;
      } catch {
        return false;
      }
    },
    discard: () => {
      draftState.resetDraft();
      draftState.clearPersistedDraft();
    },
    persist: () => {
      const result = draftState.persistDraft();
      if (!result.ok) {
        const key = result.reason === 'source_too_large'
          ? 'script_workbench.error.draft_source_too_large'
          : result.reason === 'unavailable'
            ? 'script_workbench.error.draft_storage_unavailable'
            : 'script_workbench.error.draft_storage_quota';
        throw new ScriptWorkbenchRequestError(t(key), result.reason);
      }
    },
    cancelRun: () => run.reset(),
  }), [
    aliasErrorKey,
    canEditCurrent,
    draft.id,
    draftState,
    isRunning,
    persistence,
    run,
    t,
    tab.id,
  ]);

  useEffect(() => {
    if (!draft.id) return;
    const nextIds = Array.from(new Set(
      draftConnectionSignature ? draftConnectionSignature.split('\u0000') : [],
    ));
    setConnectionIds((current) => (
      current.length === nextIds.length && current.every((id, index) => id === nextIds[index])
        ? current
        : nextIds
    ));
  }, [draft.id, draftConnectionSignature]);

  const applyOpenedScript = useCallback(async (script: ScriptLibraryScript) => {
    authorizationAbortRef.current?.abort();
    await run.reset();
    draftState.applyScript(script);
    setConnectionIds((script.connections || [])
      .map((binding) => binding.connectionId || '')
      .filter(Boolean));
    const state = useStore.getState();
    const current = state.tabs.find((candidate) => candidate.id === tab.id) || tab;
    state.addTab({
      ...current,
      title: script.name,
      scriptId: script.id,
      scriptFolderId: script.folderId,
      scriptVisibility: script.visibility,
      scriptDisplayName: script.name,
      scriptPreviewSource: undefined,
    });
  }, [draftState, run, tab]);

  const handleOpenScript = useCallback((script: ScriptLibraryScript) => {
    if (script.id === draft.id) return;
    authorizationAbortRef.current?.abort();
    if (draftState.dirty) {
      setPendingScript(script);
      setDiscardConfirmOpen(true);
      return;
    }
    void applyOpenedScript(script);
  }, [applyOpenedScript, draft.id, draftState.dirty]);

  const handleSave = useCallback(async () => {
    localError.resetDismissal();
    setError('');
    if (!canEditCurrent) {
      setError(t('script_workbench.error.forbidden'));
      return;
    }
    if (aliasErrorKey) {
      setError(t(aliasErrorKey));
      return;
    }
    try {
      await persistence.save();
    } catch (saveError) {
      setError(formatScriptWorkbenchError(saveError, t));
    }
  }, [aliasErrorKey, canEditCurrent, localError, persistence, t]);

  const handleShare = useCallback(async () => {
    if (shareBusyRef.current) return;
    localError.resetDismissal();
    setError('');
    if (!canShareCurrent) {
      setError(t('script_workbench.error.forbidden'));
      return;
    }
    if (aliasErrorKey) {
      setError(t(aliasErrorKey));
      return;
    }
    try {
      shareBusyRef.current = true;
      setShareBusy(true);
      await persistence.share();
    } catch (shareError) {
      setError(formatScriptWorkbenchError(shareError, t));
    } finally {
      shareBusyRef.current = false;
      setShareBusy(false);
    }
  }, [aliasErrorKey, canShareCurrent, localError, persistence, t]);

  const executeRun = useCallback(async (writeConfirmed: boolean) => {
    localError.resetDismissal();
    setError('');
    if (aliasErrorKey) {
      setError(t(aliasErrorKey));
      return;
    }
    const snapshot = draftState.getSnapshot();
    const executionDraft = snapshot.draft;
    const effectiveAllowWrite = Boolean(
      writeConfirmed && executionDraft.allowWrite && allowWriteEnabled,
    );
    const expectedFingerprint = buildScriptDraftFingerprint(
      executionDraft,
      effectiveAllowWrite,
    );
    const executionLimits = resolveRunLimitsForRequest(executionDraft);
    const isCurrentExecution = () => {
      const current = draftState.getSnapshot();
      return current.epoch === snapshot.epoch
        && current.draft.id === executionDraft.id
        && current.draft.source === executionDraft.source
        && (!effectiveAllowWrite || allowWriteEnabledRef.current)
        && sameScriptDraftFingerprint(
          expectedFingerprint,
          buildScriptDraftFingerprint(current.draft, effectiveAllowWrite),
        );
    };
    let authorizationController: AbortController | null = null;
    try {
      if (!isCurrentExecution()) return;
      if (effectiveAllowWrite) {
        const approved = await confirmScriptWriteRisks({
          draft: executionDraft,
          connections,
          t,
        });
        if (!approved) return;
        if (!isCurrentExecution()) return;
      }
      let confirmationToken: string | undefined;
      if (effectiveAllowWrite) {
        authorizationAbortRef.current?.abort();
        authorizationController = new AbortController();
        authorizationAbortRef.current = authorizationController;
        const authorization = await adapter.authorizeWrite({
          scriptId: executionDraft.id,
          script: executionDraft.source,
          connections: executionDraft.connections,
          inputs: executionDraft.inputs,
          allowWrite: true,
          batchSize: executionDraft.batchSize,
          inListLimit: executionDraft.inListLimit,
          timeoutMs: executionLimits.timeoutMs,
          maxDbCalls: executionLimits.maxDbCalls,
          maxOutputRows: executionLimits.maxOutputRows,
          memoryLimitBytes: executionLimits.memoryLimitBytes,
        }, authorizationController.signal);
        if (authorizationController.signal.aborted || !isCurrentExecution()) return;
        if (authorization.requiresConfirmation && !authorization.confirmationToken) {
          setError(t('script_workbench.error.write_confirmation_required'));
          return;
        }
        confirmationToken = authorization.confirmationToken;
      }
      if (!isCurrentExecution()) return;
      await run.start({
        scriptId: executionDraft.id,
        script: executionDraft.source,
        connections: executionDraft.connections,
        inputs: executionDraft.inputs,
        allowWrite: effectiveAllowWrite,
        confirmationToken,
        limits: executionLimits,
      });
    } catch (runError) {
      if (authorizationController?.signal.aborted || !isCurrentExecution()) return;
      setError(formatScriptWorkbenchError(runError, t));
    } finally {
      if (authorizationController && authorizationAbortRef.current === authorizationController) {
        authorizationAbortRef.current = null;
      }
    }
  }, [
    adapter,
    aliasErrorKey,
    allowWriteEnabled,
    connections,
    draftState,
    localError,
    run,
    t,
  ]);

  const handleRun = useCallback(() => {
    localError.resetDismissal();
    setError('');
    if (!draft.source.trim()) {
      setError(t('script_workbench.error.empty_code'));
      return;
    }
    if (aliasErrorKey) {
      setError(t(aliasErrorKey));
      return;
    }
    if (draft.allowWrite && allowWriteEnabled) {
      setWriteConfirmOpen(true);
      return;
    }
    void executeRun(false);
  }, [
    aliasErrorKey,
    allowWriteEnabled,
    draft.allowWrite,
    draft.source,
    executeRun,
    localError,
    t,
  ]);

  const handleChooseInput = useCallback(async () => {
    localError.resetDismissal();
    setError('');
    const requestedDraftInstanceId = draftState.getSnapshot().draft.draftInstanceId;
    try {
      const selected = await adapter.chooseInputFile();
      if (selected) {
        const latestSnapshot = draftState.getSnapshot();
        if (latestSnapshot.draft.draftInstanceId !== requestedDraftInstanceId) return;
        const latest = latestSnapshot.draft;
        if (latest.inputs.length >= 32) {
          setError(t('script_workbench.error.invalid_input'));
          return;
        }
        const alias = uniqueScriptAlias(
          selected.alias,
          latest.inputs.map((input) => input.alias),
        );
        draftState.updateDraft({
          inputs: [...latest.inputs, { ...selected, alias }],
        });
      }
    } catch (fileError) {
      setError(formatScriptWorkbenchError(fileError, t));
    }
  }, [adapter, draftState, localError, t]);

  const handleRemoveInput = useCallback((index: number) => {
    const latest = draftState.getSnapshot().draft;
    draftState.updateDraft({
      inputs: latest.inputs.filter((_, inputIndex) => inputIndex !== index),
    });
  }, [draftState]);

  const handleInputSheetChange = useCallback((index: number, sheetName: string) => {
    const latest = draftState.getSnapshot().draft;
    draftState.updateDraft({
      inputs: latest.inputs.map((input, inputIndex) => {
        if (inputIndex !== index) return input;
        return {
          ...input,
          ...(sheetName ? { sheetName } : { sheetName: undefined }),
        };
      }),
    });
  }, [draftState]);

  const handleRequestAI = useCallback(() => {
    const prompt = buildScriptAiPrompt({
      t,
      draft,
      connectionNames: draft.connections.map((binding) => {
        const connection = connections.find((candidate) => candidate.id === binding.connectionId);
        const target = [connection?.name || binding.connectionId, binding.database]
          .filter(Boolean)
          .join(' / ');
        return `${binding.alias}: ${target}`;
      }),
      fileNames: draft.inputs.map(inputDisplayName).filter(Boolean),
    });
    const state = useStore.getState();
    const wasClosed = !state.aiPanelVisible;
    if (wasClosed) state.setAIPanelVisible(true);
    const promptId = `script-workbench-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dispatchPrompt = () => {
      window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', {
        detail: { prompt, autoSend: false, promptId },
      }));
    };
    // The panel is lazy-loaded on first open; retry the same idempotent event
    // until its listener mounts instead of dropping the first prompt.
    const delays = wasClosed ? [0, 350, 900, 1_800, 3_200] : [0];
    delays.forEach((delay) => globalThis.setTimeout(dispatchPrompt, delay));
  }, [connections, draft, t]);

  const resolveLibraryScript = useCallback(async (
    script: ScriptLibraryScript,
  ): Promise<{ script: ScriptLibraryScript; draftInstanceId?: string }> => {
    const snapshot = draftState.getSnapshot();
    if (script.id !== snapshot.draft.id) return { script };
    const saved = snapshot.dirty ? await persistence.save() : scriptFromDraft(snapshot.draft, script);
    return {
      script: saved,
      draftInstanceId: snapshot.draft.draftInstanceId,
    };
  }, [draftState, persistence]);

  const handleLibraryScriptUpdated = useCallback((
    saved: ScriptLibraryScript,
    options: {
      includeName?: boolean;
      draftInstanceId?: string;
    } = {},
  ) => {
    if (!options.draftInstanceId) return;
    const current = draftState.getSnapshot().draft;
    if (current.draftInstanceId !== options.draftInstanceId) return;
    if (current.id && current.id !== saved.id) return;
    draftState.mergeServerMetadata(saved, {
      includeName: options.includeName,
      expectedDraftInstanceId: options.draftInstanceId,
    });
    const merged = draftState.getSnapshot().draft;
    persistence.syncLibraryScript({
      ...saved,
      name: merged.name,
      visibility: merged.visibility,
      folderId: merged.folderId,
    }, options.draftInstanceId);
  }, [draftState, persistence]);

  return (
    <section className="gn-script-workbench" data-active={isActive ? 'true' : 'false'}>
      <ScriptWorkbenchHeader
        name={draft.name}
        dirty={draftState.dirty || !draft.id}
        visibility={draft.visibility}
        connectionCount={draft.connections.length}
        running={isRunning}
        allowWrite={allowWriteEnabled && draft.allowWrite}
        canSave={canEditCurrent}
        canShare={canShareCurrent}
        shareBusy={shareBusy}
        settingsOpen={settingsOpen}
        t={t}
        onNameChange={(name) => draftState.updateDraft({ name })}
        onOpenSettings={() => setSettingsOpen((open) => !open)}
        onOpenLibrary={() => {
          setLibraryOpen(true);
          void library.refresh();
        }}
        onShare={() => { void handleShare(); }}
        onSave={() => { void handleSave(); }}
        onRun={handleRun}
        onCancel={() => { void run.cancel(); }}
        onRequestAI={handleRequestAI}
      />
      <ScriptWorkbenchContextBar
        connections={connections}
        bindings={draft.connections}
        inputs={draft.inputs}
        inputSheetStates={inputSheets.states}
        t={t}
        onChooseInput={() => { void handleChooseInput(); }}
        onRemoveInput={handleRemoveInput}
        onInputSheetChange={handleInputSheetChange}
      />
      {draftError.visible ? (
        <Alert
          className="gn-script-workbench-alert"
          type="error"
          showIcon
          message={t('script_workbench.error.operation_failed')}
          description={draftState.error}
          closable
          onClose={draftError.dismiss}
        />
      ) : null}
      {storageError.visible ? (
        <Alert
          className="gn-script-workbench-alert"
          type="warning"
          showIcon
          message={t('script_workbench.error.draft_storage')}
          description={draftState.storageError}
          closable
          onClose={storageError.dismiss}
        />
      ) : null}
      {libraryError.visible ? (
        <Alert
          className="gn-script-workbench-alert"
          type="error"
          showIcon
          message={t('script_workbench.error.operation_failed')}
          description={library.error}
          closable
          onClose={libraryError.dismiss}
          action={(
            <button
              type="button"
              className="gn-script-button"
              onClick={() => { void library.refresh(); }}
            >
              {t('script_workbench.library.retry')}
            </button>
          )}
        />
      ) : null}
      <div className="gn-script-workbench-grid">
        <div className="gn-script-workbench-center">
          <ScriptWorkbenchEditor
            name={draft.name}
            source={draft.source}
            dirty={draftState.dirty}
            t={t}
            onChange={draftState.updateSource}
            onRequestAI={handleRequestAI}
          />
          <ScriptWorkbenchResults
            status={run.status}
            progress={run.progress}
            result={run.result}
            outputs={run.outputs}
            selectedOutputId={run.selectedOutputId}
            logs={run.logs}
            audits={run.audits}
            auditsTruncated={run.auditsTruncated}
            logsTruncated={run.logsTruncated}
            outputsTruncated={run.outputsTruncated}
            pageLoading={run.pageLoading}
            errorMessage={error}
            t={t}
            onSelectOutput={run.selectOutput}
            onPageChange={(outputId, page) => {
              const selected = run.outputs.find((output) => output.outputId === outputId);
              void run.loadOutputPage(outputId, page, selected?.pageSize || 100);
            }}
          />
          <ScriptWorkbenchSettings
            open={settingsOpen}
            connections={connections}
            bindings={draft.connections}
            inputs={draft.inputs}
            allowWrite={allowWriteEnabled && draft.allowWrite}
            allowWriteEnabled={allowWriteEnabled}
            batchSize={draft.batchSize}
            inListLimit={draft.inListLimit}
            runLimits={draftRunLimits}
            runLimitBounds={runLimitBounds}
            inputSheetStates={inputSheets.states}
            t={t}
            onClose={() => setSettingsOpen(false)}
            onBindingsChange={(bindings) => {
              setConnectionIds(Array.from(new Set(
                bindings.map((binding) => binding.connectionId || '').filter(Boolean),
              )));
              const previousAlias = draft.connections[0]?.alias;
              const nextAlias = bindings[0]?.alias;
              const starterSource = scriptSourceWithPrimaryAlias(SCRIPT_STARTER_SOURCE, previousAlias);
              const nextSource = draft.source === starterSource
                ? scriptSourceWithPrimaryAlias(SCRIPT_STARTER_SOURCE, nextAlias)
                : draft.source;
              draftState.updateDraft({
                connections: bindings,
                ...(nextSource === draft.source ? {} : { source: nextSource }),
              });
            }}
            onAllowWriteChange={(allowWrite) => draftState.updateDraft({ allowWrite })}
            onBatchSizeChange={(batchSize) => draftState.updateDraft({ batchSize })}
            onInListLimitChange={(inListLimit) => draftState.updateDraft({ inListLimit })}
            onRunLimitsChange={(runLimits) => draftState.updateDraft({ runLimits })}
            onRemoveInput={handleRemoveInput}
            onInputSheetChange={handleInputSheetChange}
            onReloadInputSheets={(input) => { void inputSheets.reload(input); }}
          />
        </div>
      </div>
      {draftState.loading ? (
        <div className="gn-script-loading" aria-busy="true"><Spin /></div>
      ) : null}
      <ScriptLibraryDialog
        open={libraryOpen}
        snapshot={library.snapshot}
        loading={library.loading}
        error={library.error}
        errorCode={library.errorCode}
        currentScriptId={draft.id}
        adapter={adapter}
        t={t}
        onClose={() => setLibraryOpen(false)}
        refresh={library.refresh}
        onOpenScript={handleOpenScript}
        resolveScriptBeforeMutation={resolveLibraryScript}
        onScriptUpdated={handleLibraryScriptUpdated}
        onScriptDeleted={(scriptId) => {
          if (scriptId !== draft.id) return;
          void (async () => {
            authorizationAbortRef.current?.abort();
            await run.reset();
            draftState.resetDraft({ name: t('script_workbench.default_name') });
            useStore.setState((state) => ({
              tabs: state.tabs.map((candidate) => (
                candidate.id === tab.id
                  ? {
                    ...candidate,
                    title: t('script_workbench.default_name'),
                    scriptId: undefined,
                    scriptFolderId: undefined,
                    scriptVisibility: undefined,
                    scriptDisplayName: undefined,
                    scriptPreviewSource: undefined,
                  }
                  : candidate
              )),
            }));
            setConnectionIds(tab.connectionId ? [tab.connectionId] : []);
          })();
        }}
      />
      <ScriptWorkbenchWriteDialog
        open={writeConfirmOpen}
        source={draft.source}
        targets={writeTargets}
        t={t}
        onResolve={(confirmed) => {
          setWriteConfirmOpen(false);
          if (confirmed) void executeRun(true);
        }}
      />
      <ScriptWorkbenchConfirmDialog
        open={discardConfirmOpen}
        title={t('script_workbench.dirty_dialog.title')}
        description={t('script_workbench.dirty_dialog.description')}
        cancelLabel={t('script_workbench.action.keep')}
        confirmLabel={t('script_workbench.dirty_dialog.discard')}
        danger
        testId="script-workbench-discard-dialog"
        onResolve={(confirmed) => {
          setDiscardConfirmOpen(false);
          if (confirmed && pendingScript) void applyOpenedScript(pendingScript);
          setPendingScript(null);
        }}
      />
    </section>
  );
};

export default ScriptWorkbench;
