import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CloseOutlined, FolderAddOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type {
  ScriptLibraryFolder,
  ScriptLibraryScript,
  ScriptLibrarySnapshot,
  ScriptVisibility,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import { ScriptWorkbenchConfirmDialog } from './ScriptWorkbenchConfirmDialog';
import { ScriptLibraryFolderRow, ScriptLibraryScriptRow } from './ScriptLibraryRows';
import {
  createLibraryFolder,
  createLibraryScript,
  duplicateLibraryScript,
  renameLibraryScript,
} from './scriptLibraryOperations';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';
import { formatScriptWorkbenchError } from './scriptWorkbenchErrors';
import {
  canEditFolderItem,
  canEditScriptItem,
  canShareFolderItem,
  canShareScriptItem,
} from './scriptWorkbenchPermissions';

type LibraryFilter = 'all' | 'private' | 'shared' | `folder:${string}`;

interface PendingDelete {
  kind: 'script' | 'folder';
  id: string;
  revision: number;
  name: string;
}

interface ScriptLibraryDialogProps {
  open: boolean;
  snapshot: ScriptLibrarySnapshot | null;
  loading: boolean;
  error: string;
  errorCode?: string;
  currentScriptId?: string;
  adapter: ScriptWorkbenchAdapter;
  t: ScriptWorkbenchTranslate;
  onClose: () => void;
  refresh: () => Promise<ScriptLibrarySnapshot | null>;
  onOpenScript: (script: ScriptLibraryScript) => void;
  resolveScriptBeforeMutation?: (script: ScriptLibraryScript) => Promise<{
    script: ScriptLibraryScript;
    draftInstanceId?: string;
  }>;
  onScriptUpdated?: (
    script: ScriptLibraryScript,
    options?: { includeName?: boolean; draftInstanceId?: string },
  ) => void;
  onScriptDeleted: (scriptId: string) => void;
}

export const ScriptLibraryDialog: React.FC<ScriptLibraryDialogProps> = ({
  open,
  snapshot,
  loading,
  error,
  errorCode = '',
  currentScriptId,
  adapter,
  t,
  onClose,
  refresh,
  onOpenScript,
  resolveScriptBeforeMutation,
  onScriptUpdated,
  onScriptDeleted,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [search, setSearch] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [localError, setLocalError] = useState('');
  const [editingScriptId, setEditingScriptId] = useState('');
  const [editingName, setEditingName] = useState('');
  const [editingFolderId, setEditingFolderId] = useState('');
  const [editingFolderName, setEditingFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const scriptRenameCancelledRef = useRef(false);
  const folderRenameCancelledRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close('close');
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  const scripts = snapshot?.scripts || [];
  const folders = snapshot?.folders || [];
  const canWrite = snapshot?.canWrite === true;
  const selectedFolderId = filter.startsWith('folder:') ? filter.slice('folder:'.length) : '';
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);
  const targetVisibility: ScriptVisibility = selectedFolder?.visibility
    || (filter === 'shared' ? 'shared' : 'private');
  const filteredScripts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scripts.filter((script) => {
      if (filter === 'private' && script.visibility !== 'private') return false;
      if (filter === 'shared' && script.visibility !== 'shared') return false;
      if (selectedFolderId && script.folderId !== selectedFolderId) return false;
      return !query || `${script.name} ${script.description || ''}`.toLowerCase().includes(query);
    });
  }, [filter, scripts, search, selectedFolderId]);

  const runLibraryAction = async (key: string, action: () => Promise<void>) => {
    if (busyKey) return;
    setBusyKey(key);
    setLocalError('');
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setLocalError(formatScriptWorkbenchError(actionError, t));
    } finally {
      setBusyKey('');
    }
  };

  const closeDialog = () => dialogRef.current?.close('close');
  const canModifyScript = (script: ScriptLibraryScript) => canEditScriptItem(snapshot, script);
  const canModifyFolder = (folder: ScriptLibraryFolder) => canEditFolderItem(snapshot, folder);

  const handleCreateScript = () => {
    void runLibraryAction('create-script', async () => {
      const created = await createLibraryScript({
        adapter,
        name: t('script_workbench.default_name'),
        visibility: targetVisibility,
        folderId: selectedFolderId || undefined,
      });
      onOpenScript(created);
      closeDialog();
    });
  };

  const handleCreateFolder = () => {
    const name = folderName.trim();
    if (!name) return;
    void runLibraryAction('create-folder', async () => {
      const folder = await createLibraryFolder({
        adapter,
        name,
        visibility: targetVisibility,
        parentId: selectedFolderId || undefined,
      });
      setFilter(`folder:${folder.id}`);
      setCreatingFolder(false);
      setFolderName('');
    });
  };

  const finishScriptRename = () => {
    if (scriptRenameCancelledRef.current) {
      scriptRenameCancelledRef.current = false;
      return;
    }
    const scriptId = editingScriptId;
    const name = editingName.trim();
    setEditingScriptId('');
    if (!scriptId || !name) return;
    void runLibraryAction(`rename:${scriptId}`, async () => {
      const script = scripts.find((candidate) => candidate.id === scriptId);
      if (!script) return;
      const resolved = resolveScriptBeforeMutation
        ? await resolveScriptBeforeMutation(script)
        : { script };
      const current = resolved.script;
      const renamed = await renameLibraryScript({ adapter, scriptId, name, script: current });
      onScriptUpdated?.(renamed, {
        includeName: true,
        draftInstanceId: resolved.draftInstanceId,
      });
    });
  };

  const cancelScriptRename = () => {
    scriptRenameCancelledRef.current = true;
    setEditingScriptId('');
    setEditingName('');
  };

  const finishFolderRename = () => {
    if (folderRenameCancelledRef.current) {
      folderRenameCancelledRef.current = false;
      return;
    }
    const folderId = editingFolderId;
    const name = editingFolderName.trim();
    setEditingFolderId('');
    if (!folderId || !name) return;
    void runLibraryAction(`rename-folder:${folderId}`, async () => {
      const folder = folders.find((candidate) => candidate.id === folderId);
      if (!folder) return;
      await adapter.saveFolder({
        id: folder.id,
        name,
        parentId: folder.parentId,
        visibility: folder.visibility,
        revision: folder.revision,
      });
    });
  };

  const cancelFolderRename = () => {
    folderRenameCancelledRef.current = true;
    setEditingFolderId('');
    setEditingFolderName('');
  };

  const handleShare = (script: ScriptLibraryScript) => {
    void runLibraryAction(`share:${script.id}`, async () => {
      const resolved = resolveScriptBeforeMutation
        ? await resolveScriptBeforeMutation(script)
        : { script };
      const current = resolved.script;
      const shared = await adapter.shareScript({
        id: current.id,
        revision: current.revision,
        visibility: current.visibility === 'shared' ? 'private' : 'shared',
      });
      onScriptUpdated?.(shared, {
        draftInstanceId: resolved.draftInstanceId,
      });
    });
  };

  const handleShareFolder = (folder: ScriptLibraryFolder) => {
    void runLibraryAction(`share-folder:${folder.id}`, async () => {
      await adapter.shareFolder({
        id: folder.id,
        revision: folder.revision,
        visibility: folder.visibility === 'shared' ? 'private' : 'shared',
      });
    });
  };

  const handleConfirmDelete = (confirmed: boolean) => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!confirmed || !target) return;
    void runLibraryAction(`delete:${target.id}`, async () => {
      if (target.kind === 'script') {
        let revision = target.revision;
        if (target.id === currentScriptId && resolveScriptBeforeMutation) {
          const script = scripts.find((candidate) => candidate.id === target.id);
          if (script) {
            const resolved = await resolveScriptBeforeMutation(script);
            revision = resolved.script.revision;
          }
        }
        await adapter.deleteScript({ id: target.id, revision });
        onScriptDeleted(target.id);
      } else {
        await adapter.deleteFolder({ id: target.id, revision: target.revision });
        if (filter === `folder:${target.id}`) setFilter('all');
      }
    });
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        className="gn-script-library-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="script-library-dialog"
      >
        <header className="gn-script-library-header">
          <div>
            <h2 id={titleId}>{t('script_workbench.library.title')}</h2>
            <p id={descriptionId}>{t('script_workbench.library.description')}</p>
          </div>
          <button type="button" className="gn-script-icon-button" aria-label={t('script_workbench.action.close')} onClick={closeDialog}>
            <CloseOutlined aria-hidden="true" />
          </button>
        </header>
        <div className="gn-script-library-toolbar">
          <label className="gn-script-search">
            <span className="gn-visually-hidden">{t('script_workbench.library.search_placeholder')}</span>
            <SearchOutlined aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('script_workbench.library.search_placeholder')}
            />
          </label>
          <button
            type="button"
            className="gn-script-button"
            data-testid="script-library-new-script"
            onClick={handleCreateScript}
            disabled={!canWrite || Boolean(busyKey)}
          >
            <PlusOutlined aria-hidden="true" />
            {t('script_workbench.action.new_script')}
          </button>
          <button type="button" className="gn-script-button" onClick={() => setCreatingFolder(true)} disabled={!canWrite}>
            <FolderAddOutlined aria-hidden="true" />
            {t('script_workbench.action.new_folder')}
          </button>
        </div>
        {(error || localError) ? (
          <div className="gn-script-library-error" role="alert">
            <span>
              {localError
                || (errorCode === 'forbidden'
                  ? t('script_workbench.library.no_permission')
                  : error || t('script_workbench.library.load_failed'))}
            </span>
            {!localError && error ? (
              <button
                type="button"
                onClick={() => { void refresh(); }}
                disabled={loading}
              >
                {t('script_workbench.library.retry')}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="gn-script-library-body">
          <nav className="gn-script-library-filters" aria-label={t('script_workbench.library.folders')}>
            <button type="button" aria-pressed={filter === 'all'} className={filter === 'all' ? 'is-active' : undefined} onClick={() => setFilter('all')}>
              {t('script_workbench.library.filter_all')}<small>{scripts.length}</small>
            </button>
            <button type="button" aria-pressed={filter === 'private'} className={filter === 'private' ? 'is-active' : undefined} onClick={() => setFilter('private')}>
              {t('script_workbench.library.filter_private')}
            </button>
            <button type="button" aria-pressed={filter === 'shared'} className={filter === 'shared' ? 'is-active' : undefined} onClick={() => setFilter('shared')}>
              {t('script_workbench.library.filter_shared')}
            </button>
            <div className="gn-script-library-divider" />
            <ul>
              {folders.map((folder) => (
                <ScriptLibraryFolderRow
                  key={folder.id}
                  folder={folder}
                  count={scripts.filter((script) => script.folderId === folder.id).length}
                  active={filter === `folder:${folder.id}`}
                  canModify={canModifyFolder(folder)}
                  canShare={canShareFolderItem(snapshot, folder)}
                  editing={editingFolderId === folder.id}
                  editingName={editingFolderName}
                  busy={busyKey === `share-folder:${folder.id}`
                    || busyKey === `delete:${folder.id}`
                    || busyKey === `rename-folder:${folder.id}`}
                  t={t}
                  onSelect={() => setFilter(`folder:${folder.id}`)}
                  onStartRename={() => {
                    folderRenameCancelledRef.current = false;
                    setEditingFolderId(folder.id);
                    setEditingFolderName(folder.name);
                  }}
                  onRenameChange={setEditingFolderName}
                  onFinishRename={finishFolderRename}
                  onCancelRename={cancelFolderRename}
                  onShare={() => handleShareFolder(folder)}
                  onDelete={() => {
                    if (canModifyFolder(folder)) {
                      setPendingDelete({ kind: 'folder', id: folder.id, revision: folder.revision, name: folder.name });
                    }
                  }}
                />
              ))}
            </ul>
            {creatingFolder ? (
              <div className="gn-script-library-folder-create">
                <input
                  value={folderName}
                  aria-label={t('script_workbench.library.folder_name')}
                  placeholder={t('script_workbench.library.new_folder_placeholder')}
                  onChange={(event) => setFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleCreateFolder();
                    if (event.key === 'Escape') setCreatingFolder(false);
                  }}
                  autoFocus
                />
                <button type="button" onClick={handleCreateFolder} disabled={!folderName.trim()}>
                  {t('script_workbench.action.create')}
                </button>
              </div>
            ) : null}
          </nav>
          <section className="gn-script-library-list" aria-label={t('script_workbench.library.scripts')} aria-busy={loading}>
            {filteredScripts.length === 0 ? (
              <div className="gn-script-library-empty">{t('script_workbench.library.empty')}</div>
            ) : (
              <ul>
                {filteredScripts.map((script) => (
                  <ScriptLibraryScriptRow
                    key={script.id}
                    script={script}
                    active={script.id === currentScriptId}
                    canModify={canModifyScript(script)}
                    canShare={canShareScriptItem(snapshot, script)}
                    editing={editingScriptId === script.id}
                    editingName={editingName}
                    busy={busyKey === `rename:${script.id}` || busyKey === `share:${script.id}` || busyKey === `delete:${script.id}`}
                    t={t}
                    onOpen={() => {
                      onOpenScript(script);
                      closeDialog();
                    }}
                    onStartRename={() => {
                      scriptRenameCancelledRef.current = false;
                      setEditingScriptId(script.id);
                      setEditingName(script.name);
                    }}
                    onRenameChange={setEditingName}
                    onFinishRename={finishScriptRename}
                    onCancelRename={cancelScriptRename}
                    onDuplicate={() => {
                      void runLibraryAction(`duplicate:${script.id}`, async () => {
                        await duplicateLibraryScript({
                          adapter,
                          scriptId: script.id,
                          suffix: t('script_workbench.library.duplicate_suffix'),
                        });
                      });
                    }}
                    onShare={() => handleShare(script)}
                    onDelete={() => setPendingDelete({
                      kind: 'script',
                      id: script.id,
                      revision: script.revision,
                      name: script.name,
                    })}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
        <footer className="gn-script-library-footer">
          <span aria-live="polite">
            {loading
              ? t('script_workbench.library.loading')
              : t('script_workbench.library.count', { count: filteredScripts.length })}
          </span>
          <button type="button" className="gn-script-button" onClick={closeDialog}>{t('script_workbench.action.close')}</button>
        </footer>
      </dialog>
      <ScriptWorkbenchConfirmDialog
        open={Boolean(pendingDelete)}
        title={t('script_workbench.library.delete_title')}
        description={t('script_workbench.library.delete_description', { name: pendingDelete?.name || '' })}
        cancelLabel={t('script_workbench.action.keep')}
        confirmLabel={t('script_workbench.action.delete')}
        danger
        testId="script-library-delete-dialog"
        onResolve={handleConfirmDelete}
      />
    </>
  );
};
