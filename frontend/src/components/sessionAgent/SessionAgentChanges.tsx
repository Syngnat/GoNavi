import React from 'react';
import { FileOutlined, RightOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import type { SessionBlockContent, SessionContentRef, SessionMessageView } from './sessionAgentApi';
import { ExpandFull, SessionAgentPatchText } from './SessionAgentTools';
import { buildSessionChanges, sessionChangeMatches, type SessionChangeFile } from './sessionAgentView';

export const SessionAgentChanges: React.FC<{
  messages: SessionMessageView[];
  needle: string;
  onOpenFull: (ref: SessionContentRef) => Promise<SessionBlockContent | null>;
}> = ({ messages, needle, onOpenFull }) => {
  const changes = React.useMemo(() => buildSessionChanges(messages), [messages]);
  const visible = changes.filter((file) => sessionChangeMatches(file, needle));
  if (!changes.length) {
    return <div className="gn-session-agent-detail-empty-body" data-session-agent-changes="true">{t('session_agent.detail.changes_empty')}</div>;
  }
  if (!visible.length) {
    return <div className="gn-session-agent-detail-empty-body" data-session-agent-changes="true">{t('session_agent.detail.no_match')}</div>;
  }
  const added = visible.reduce((sum, file) => sum + file.added, 0);
  const removed = visible.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="gn-session-agent-changes" data-session-agent-changes="true">
      <div className="gn-session-agent-changes-summary">
        <strong>{t('session_agent.detail.change_files', { count: visible.length })}</strong>
        <span className="gn-session-agent-diff-added">+{added}</span>
        <span className="gn-session-agent-diff-removed">−{removed}</span>
      </div>
      <div className="gn-session-agent-change-list">
        {visible.map((file) => <ChangeFile key={file.path} file={file} expanded={Boolean(needle)} onOpenFull={onOpenFull} />)}
      </div>
    </div>
  );
};

const ChangeFile: React.FC<{
  file: SessionChangeFile;
  expanded: boolean;
  onOpenFull: (ref: SessionContentRef) => Promise<SessionBlockContent | null>;
}> = ({ file, expanded, onOpenFull }) => (
  <details className="gn-session-agent-change-file" open={expanded || undefined}>
    <summary>
      <RightOutlined className="gn-session-agent-change-caret" />
      <FileOutlined className="gn-session-agent-change-icon" />
      <span className="gn-session-agent-change-path" title={file.path}>{file.path}</span>
      <span className="gn-session-agent-change-op">{changeOperationLabel(file.op)}</span>
      <span className="gn-session-agent-diff-added">+{file.added}</span>
      <span className="gn-session-agent-diff-removed">−{file.removed}</span>
    </summary>
    <div className="gn-session-agent-change-patches">
      {file.patches.map((patch, index) => (
        <section key={`${patch.id}-${index}`} className="gn-session-agent-patch-section">
          <div className="gn-session-agent-patch-title">{patch.title}</div>
          {patch.inputText ? (
            <SessionAgentPatchText text={patch.inputText} />
          ) : patch.inputFull ? (
            <ExpandFull blockRef={patch.inputFull} onOpenFull={onOpenFull} patch preview={patch.inputPreview} />
          ) : patch.inputPreview ? (
            <SessionAgentPatchText text={patch.inputPreview} />
          ) : null}
        </section>
      ))}
    </div>
  </details>
);

const changeOperationLabel = (op: string): string => {
  const normalized = op.toLowerCase();
  if (normalized === 'add' || normalized === 'added' || normalized === 'create') return t('session_agent.changes.op_add');
  if (normalized === 'delete' || normalized === 'deleted' || normalized === 'remove') return t('session_agent.changes.op_delete');
  if (normalized === 'rename' || normalized === 'renamed' || normalized === 'move') return t('session_agent.changes.op_rename');
  return t('session_agent.changes.op_update');
};
