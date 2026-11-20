import React, { useEffect, useRef, useState } from 'react';
import {
  BookOutlined,
  CodeOutlined,
  EditOutlined,
  LockOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SaveOutlined,
  ShareAltOutlined,
  SlidersOutlined,
  StopOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { ScriptVisibility } from './scriptWorkbenchTypes';
import type { ScriptWorkbenchTranslate } from './useScriptWorkbenchCopy';

interface ScriptWorkbenchHeaderProps {
  name: string;
  dirty: boolean;
  visibility: ScriptVisibility;
  connectionCount: number;
  running: boolean;
  allowWrite: boolean;
  canSave: boolean;
  canShare: boolean;
  shareBusy: boolean;
  settingsOpen: boolean;
  t: ScriptWorkbenchTranslate;
  onNameChange: (name: string) => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  onShare: () => void;
  onSave: () => void;
  onRun: () => void;
  onCancel: () => void;
  onRequestAI: () => void;
}

export const ScriptWorkbenchHeader: React.FC<ScriptWorkbenchHeaderProps> = ({
  name,
  dirty,
  visibility,
  connectionCount,
  running,
  allowWrite,
  canSave,
  canShare,
  shareBusy,
  settingsOpen,
  t,
  onNameChange,
  onOpenLibrary,
  onOpenSettings,
  onShare,
  onSave,
  onRun,
  onCancel,
  onRequestAI,
}) => {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(name);
  const cancelRenameRef = useRef(false);

  useEffect(() => {
    if (!editingName) setNameValue(name);
  }, [editingName, name]);

  const finishRename = () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    const next = nameValue.trim();
    cancelRenameRef.current = true;
    setEditingName(false);
    setNameValue(name);
    if (next && next !== name) onNameChange(next);
  };

  return (
  <header className="gn-script-workbench-header">
    <div className="gn-script-workbench-heading">
      <span className="gn-script-workbench-heading-icon" aria-hidden="true"><CodeOutlined /></span>
      {editingName ? (
        <input
          className="gn-script-workbench-name-input"
          value={nameValue}
          aria-label={t('script_workbench.library.script_name')}
          maxLength={120}
          autoFocus
          onChange={(event) => setNameValue(event.target.value)}
          onBlur={finishRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              finishRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelRenameRef.current = true;
              setEditingName(false);
              setNameValue(name);
            }
          }}
        />
      ) : (
        <h1>{name}</h1>
      )}
      {!editingName && canSave ? (
        <button
          type="button"
          className="gn-script-icon-button"
          aria-label={t('script_workbench.action.rename')}
          onClick={() => {
            cancelRenameRef.current = false;
            setEditingName(true);
          }}
        >
          <EditOutlined aria-hidden="true" />
        </button>
      ) : null}
      <span className={`gn-script-visibility-badge is-${visibility}`}>
        {visibility === 'shared' ? <TeamOutlined aria-hidden="true" /> : <LockOutlined aria-hidden="true" />}
        {t(`script_workbench.badge.${visibility}`)}
      </span>
      <span className="gn-script-heading-separator" aria-hidden="true" />
      <span className="gn-script-workbench-meta">
        {t('script_workbench.meta.connections', { count: connectionCount })}
        {' · '}
        {allowWrite ? t('script_workbench.meta.write') : t('script_workbench.meta.readonly')}
        {' · '}
        {dirty ? t('script_workbench.meta.unsaved') : t('script_workbench.meta.saved')}
      </span>
    </div>
    <div className="gn-script-workbench-head-actions">
      <button
        type="button"
        className="gn-script-button"
        data-testid="script-workbench-settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={onOpenSettings}
      >
        <SlidersOutlined aria-hidden="true" />{t('script_workbench.settings.title')}
      </button>
      <button type="button" className="gn-script-button" data-testid="script-workbench-library" onClick={onOpenLibrary}>
        <BookOutlined aria-hidden="true" />{t('script_workbench.action.library')}
      </button>
      <button type="button" className="gn-script-button" onClick={onRequestAI}>
        <RobotOutlined aria-hidden="true" />{t('script_workbench.action.ai')}
      </button>
      <button
        type="button"
        className="gn-script-button"
        data-testid="script-workbench-share"
        aria-busy={shareBusy || undefined}
        onClick={onShare}
        disabled={!canShare || shareBusy}
      >
        <ShareAltOutlined aria-hidden="true" />
        {visibility === 'shared'
          ? t('script_workbench.action.unshare')
          : t('script_workbench.action.share')}
      </button>
      <button type="button" className="gn-script-button" data-testid="script-workbench-save" onClick={onSave} disabled={!canSave}>
        <SaveOutlined aria-hidden="true" />{t('script_workbench.action.save')}
      </button>
      {running ? (
        <button type="button" className="gn-script-button gn-script-button--danger" data-testid="script-workbench-cancel" onClick={onCancel}>
          <StopOutlined aria-hidden="true" />{t('script_workbench.action.cancel')}
        </button>
      ) : (
        <button type="button" className="gn-script-button gn-script-button--primary" data-testid="script-workbench-run" onClick={onRun}>
          <PlayCircleOutlined aria-hidden="true" />{t('script_workbench.action.run')}
        </button>
      )}
    </div>
  </header>
  );
};
