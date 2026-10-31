import React from 'react';
import { message } from 'antd';
import { CheckOutlined, CloseOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import { sessionAgentErrorText } from './sessionAgentApi';
import type { SessionBlockContent, SessionBlockView, SessionContentRef } from './sessionAgentApi';
import type { SessionToolCall } from './sessionAgentView';

export const unescapeToolText = (text: string): string =>
  (text || '').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');

export const SessionAgentPatchText: React.FC<{ text: string }> = ({ text }) => (
  <pre className="gn-session-agent-patch">{
    unescapeToolText(text).split('\n').map((line, index) => {
      const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : '';
      return <span key={`${index}-${line.slice(0, 12)}`} className={`gn-session-agent-patch-line ${kind}`}>{line}{'\n'}</span>;
    })
  }</pre>
);

export const ExpandFull: React.FC<{
  blockRef: SessionContentRef;
  onOpenFull: (ref: SessionContentRef) => Promise<SessionBlockContent | null>;
  patch?: boolean;
  /** 折叠态展示的预览；展开加载全文后由全文替换，避免内容重复。 */
  preview?: string;
}> = ({ blockRef, onOpenFull, patch = false, preview }) => {
  const [content, setContent] = React.useState<SessionBlockContent | null>(null);
  const [loading, setLoading] = React.useState(false);
  const toggle = async () => {
    if (content) {
      setContent(null);
      return;
    }
    setLoading(true);
    try {
      const full = await onOpenFull(blockRef);
      if (full) setContent(full);
      else message.warning(t('session_agent.error.content_failed'));
    } catch (err) {
      message.error(sessionAgentErrorText(err, 'session_agent.error.content_failed'));
    } finally {
      setLoading(false);
    }
  };
  const body = content
    ? patch
      ? <SessionAgentPatchText text={content.text} />
      : <pre className="gn-session-agent-tooldetail expanded">{unescapeToolText(content.text)}</pre>
    : preview
      ? <SessionAgentPatchText text={preview} />
      : null;
  return (
    <div className="gn-session-agent-expand">
      {body}
      <button type="button" className="gn-session-agent-expand-toggle" onClick={toggle} disabled={loading} data-session-agent-expand-full="true">
        <RightOutlined className={`gn-session-agent-expand-caret${content ? ' open' : ''}`} />
        {content ? t('session_agent.detail.collapse_full') : t('session_agent.detail.expand_full')}
      </button>
    </div>
  );
};

export const ExecSection: React.FC<{
  blocks: SessionBlockView[];
  stepCount?: number;
  errorCount?: number;
  fileCount?: number;
  aborted?: boolean;
  defaultOpen?: boolean;
  onOpenFull: (ref: SessionContentRef) => Promise<SessionBlockContent | null>;
}> = ({ blocks, stepCount, errorCount = 0, fileCount = 0, aborted = false, defaultOpen = false, onOpenFull }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  React.useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const calls = blocks.filter((block) => block.type === 'tool_call' && block.toolCall);
  const results = new Map<string, SessionBlockView>();
  for (const block of blocks) {
    if (block.type === 'tool_result' && block.toolResult) results.set(block.toolResult.callId, block);
  }
  return (
    <div className={`gn-session-agent-exec${open ? ' open' : ''}`}>
      <button type="button" className="gn-session-agent-exec-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <RightOutlined className={`gn-session-agent-exec-caret${open ? ' open' : ''}`} />
        <span className="gn-session-agent-exec-title">{t('session_agent.detail.steps', { count: stepCount ?? calls.length })}</span>
        <span className="gn-session-agent-exec-stat">{t('session_agent.detail.files', { count: fileCount })}</span>
        {errorCount > 0 ? <span className="gn-session-agent-exec-stat is-error">{t('session_agent.detail.errors', { count: errorCount })}</span> : null}
        {aborted ? <span className="gn-session-agent-exec-stat is-error">{t('session_agent.detail.aborted')}</span> : null}
      </button>
      {open ? (
        <div className="gn-session-agent-exec-body">
          {calls.map((block, index) => (
            <ToolRow
              key={block.toolCall?.id ?? index}
              call={block.toolCall!}
              result={results.get(block.toolCall?.id ?? '')?.toolResult}
              onOpenFull={onOpenFull}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const ToolRow: React.FC<{
  call: SessionToolCall;
  result?: SessionBlockView['toolResult'];
  onOpenFull: (ref: SessionContentRef) => Promise<SessionBlockContent | null>;
}> = ({ call, result, onOpenFull }) => {
  const [open, setOpen] = React.useState(false);
  const status = result?.status ?? 'pending';
  return (
    <div className="gn-session-agent-toolrow">
      <button type="button" className="gn-session-agent-toolline" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`gn-session-agent-toolstatus ${status}`}>
          {status === 'success' ? <CheckOutlined /> : status === 'error' ? <CloseOutlined /> : <LoadingOutlined />}
        </span>
        <span className="gn-session-agent-tooltitle">{call.title}</span>
        <span className="gn-session-agent-toolkind">{call.kind}</span>
        {call.diff ? <span className="gn-session-agent-tooldiff"><span>+{call.diff.added}</span> <span>−{call.diff.removed}</span></span> : null}
      </button>
      {open ? (
        <div className="gn-session-agent-toolpayload">
          {call.inputPreview || call.detail ? <pre className="gn-session-agent-tooldetail">{unescapeToolText(call.inputPreview || call.detail || '')}</pre> : null}
          {call.inputFull ? <ExpandFull blockRef={call.inputFull} onOpenFull={onOpenFull} /> : null}
          {result?.preview ? <pre className="gn-session-agent-tooldetail">{unescapeToolText(result.preview)}</pre> : null}
          {result?.truncated && result.full ? <ExpandFull blockRef={result.full} onOpenFull={onOpenFull} /> : null}
        </div>
      ) : null}
    </div>
  );
};
