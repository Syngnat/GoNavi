import React from 'react';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  LockOutlined,
  ShareAltOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type {
  ScriptLibraryFolder,
  ScriptLibraryScript,
} from './scriptWorkbenchTypes';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';

export const ScriptLibraryScriptRow: React.FC<{
  script: ScriptLibraryScript;
  active: boolean;
  canModify: boolean;
  canShare: boolean;
  editing: boolean;
  editingName: string;
  busy: boolean;
  t: ScriptWorkbenchTranslate;
  onOpen: () => void;
  onStartRename: () => void;
  onRenameChange: (value: string) => void;
  onFinishRename: () => void;
  onCancelRename: () => void;
  onDuplicate: () => void;
  onShare: () => void;
  onDelete: () => void;
}> = ({
  script,
  active,
  canModify,
  canShare,
  editing,
  editingName,
  busy,
  t,
  onOpen,
  onStartRename,
  onRenameChange,
  onFinishRename,
  onCancelRename,
  onDuplicate,
  onShare,
  onDelete,
}) => (
  <li className={`gn-script-library-script${active ? ' is-active' : ''}`}>
    {editing ? (
      <div className="gn-script-library-script-open is-editing">
        <span className="gn-script-library-script-icon" aria-hidden="true">
          {script.visibility === 'shared' ? <TeamOutlined /> : <LockOutlined />}
        </span>
        <span className="gn-script-library-script-copy">
          <input
            value={editingName}
            aria-label={t('script_workbench.library.script_name')}
            onChange={(event) => onRenameChange(event.target.value)}
            onBlur={onFinishRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onFinishRename();
              else if (event.key === 'Escape') onCancelRename();
            }}
            autoFocus
          />
          <small>{t('script_workbench.library.revision', { revision: script.revision })}</small>
        </span>
      </div>
    ) : (
      <button
        type="button"
        className="gn-script-library-script-open"
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
      >
      <span className="gn-script-library-script-icon" aria-hidden="true">
        {script.visibility === 'shared' ? <TeamOutlined /> : <LockOutlined />}
      </span>
      <span className="gn-script-library-script-copy">
        <strong>{script.name}</strong>
        <small>
          {t('script_workbench.library.revision', { revision: script.revision })}
          {' · '}
          {new Date(script.updatedAt).toLocaleString()}
        </small>
      </span>
      </button>
    )}
    <span className="gn-script-library-script-actions">
      {canModify ? (
        <>
          <button type="button" aria-label={t('script_workbench.action.rename')} onClick={onStartRename} disabled={busy}>
            <EditOutlined aria-hidden="true" />
          </button>
          <button type="button" aria-label={t('script_workbench.action.duplicate')} onClick={onDuplicate} disabled={busy}>
            <CopyOutlined aria-hidden="true" />
          </button>
        </>
      ) : null}
      {canShare && canModify ? (
        <button
          type="button"
          aria-label={script.visibility === 'shared'
            ? t('script_workbench.action.unshare')
            : t('script_workbench.action.share')}
          onClick={onShare}
          disabled={busy}
        >
          <ShareAltOutlined aria-hidden="true" />
        </button>
      ) : null}
      {canModify ? (
        <button
          type="button"
          className="is-danger"
          aria-label={t('script_workbench.action.delete')}
          onClick={onDelete}
          disabled={busy}
        >
          <DeleteOutlined aria-hidden="true" />
        </button>
      ) : null}
    </span>
  </li>
);

export const ScriptLibraryFolderRow: React.FC<{
  folder: ScriptLibraryFolder;
  count: number;
  active: boolean;
  canModify: boolean;
  canShare: boolean;
  editing: boolean;
  editingName: string;
  busy: boolean;
  t: ScriptWorkbenchTranslate;
  onSelect: () => void;
  onStartRename: () => void;
  onRenameChange: (value: string) => void;
  onFinishRename: () => void;
  onCancelRename: () => void;
  onShare: () => void;
  onDelete: () => void;
}> = ({
  folder,
  count,
  active,
  canModify,
  canShare,
  editing,
  editingName,
  busy,
  t,
  onSelect,
  onStartRename,
  onRenameChange,
  onFinishRename,
  onCancelRename,
  onShare,
  onDelete,
}) => (
  <li className={`gn-script-library-folder${active ? ' is-active' : ''}`}>
    {editing ? (
      <div className="gn-script-library-folder-open is-editing">
        <FolderOutlined aria-hidden="true" />
        <input
          value={editingName}
          aria-label={t('script_workbench.library.folder_name')}
          onChange={(event) => onRenameChange(event.target.value)}
          onBlur={onFinishRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onFinishRename();
            else if (event.key === 'Escape') onCancelRename();
          }}
          autoFocus
        />
      </div>
    ) : (
      <button type="button" aria-current={active ? 'page' : undefined} onClick={onSelect}>
        <FolderOutlined aria-hidden="true" />
        <span title={folder.name}>{folder.name}</span>
        <small>{count}</small>
      </button>
    )}
    <span className="gn-script-library-folder-actions">
      {canModify ? (
        <button type="button" aria-label={t('script_workbench.action.rename')} onClick={onStartRename} disabled={busy}>
          <EditOutlined aria-hidden="true" />
        </button>
      ) : null}
      {canShare && canModify ? (
        <button
          type="button"
          aria-label={folder.visibility === 'shared'
            ? t('script_workbench.action.unshare')
            : t('script_workbench.action.share')}
          onClick={onShare}
          disabled={busy}
        >
          <ShareAltOutlined aria-hidden="true" />
        </button>
      ) : null}
      {canModify ? (
        <button
          type="button"
          aria-label={t('script_workbench.action.delete')}
          className="is-danger"
          onClick={onDelete}
          disabled={busy}
        >
          <DeleteOutlined aria-hidden="true" />
        </button>
      ) : null}
    </span>
  </li>
);
