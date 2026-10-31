import React from 'react';
import { CheckOutlined, UserOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import type { SessionAgentItem, SessionBlockContent, SessionBlockView, SessionContentRef, SessionMessageView, SessionTurnView } from './sessionAgentApi';
import { ProviderAvatar } from './SessionAgentListPage';
import { SessionAgentMarkdown } from './SessionAgentMarkdown';
import { SessionAgentImage, SessionAgentInlineImage } from './SessionAgentImage';
import { SessionAgentStructuredBody } from './SessionAgentStructuredBody';
import { ExecSection } from './SessionAgentTools';
import { sessionTurnMatches, turnBlocks, turnFileCount, turnMessages } from './sessionAgentView';

interface TurnProps {
  item: SessionAgentItem;
  messages: SessionMessageView[];
  turns: SessionTurnView[];
  needle: string;
  onOpenFull: (ref: SessionContentRef) => Promise<SessionBlockContent | null>;
}

export const SessionAgentTurns: React.FC<TurnProps> = ({ item, messages, turns, needle, onOpenFull }) => {
  const visible = turns.filter((turn) => sessionTurnMatches(turn, messages, needle));
  if (!visible.length) {
    return <div className="gn-session-agent-detail-empty-body">{t(needle ? 'session_agent.detail.no_match' : 'session_agent.detail.empty')}</div>;
  }
  return (
    <div className="gn-session-agent-timeline" data-session-agent-timeline="true">
      {visible.map((turn) => (
        <TurnSection
          key={turn.turnId + turn.firstMessageIndex}
          number={turns.indexOf(turn) + 1}
          turn={turn}
          item={item}
          messages={turnMessages(turn, messages)}
          searching={Boolean(needle)}
          onOpenFull={onOpenFull}
        />
      ))}
    </div>
  );
};

const TurnSection: React.FC<{
  number: number;
  turn: SessionTurnView;
  item: SessionAgentItem;
  messages: SessionMessageView[];
  searching: boolean;
  onOpenFull: (ref: SessionContentRef) => Promise<SessionBlockContent | null>;
}> = ({ number, turn, item, messages, searching, onOpenFull }) => {
  const users = messages.filter((message) => message.role === 'user' && !message.injected && message.content.trim());
  const assistants = messages.filter((message) => message.role === 'assistant' && hasAssistantContent(message));
  const systems = messages.filter((message) => message.role === 'system' && message.content.trim());
  const blocks = turnBlocks(messages);
  const hasTools = blocks.some((block) => block.type === 'tool_call');
  return (
    <article className="gn-session-agent-turn" data-session-agent-turn={turn.turnId}>
      <div className="gn-session-agent-turn-label">{t('session_agent.detail.turn_number', { index: String(number).padStart(2, '0') })}</div>
      {users.length || turn.questionPreview ? (
        <section className="gn-session-agent-request">
          <div className="gn-session-agent-section-label"><UserOutlined />{t('session_agent.detail.request')}</div>
          {users.length ? users.map((message, index) => (
            <div className="gn-session-agent-request-text" key={message.id ?? index}><SessionAgentMarkdown content={message.content} /></div>
          )) : <div className="gn-session-agent-request-text">{turn.questionPreview}</div>}
        </section>
      ) : null}
      {assistants.length ? (
        <section className="gn-session-agent-answer">
          <div className="gn-session-agent-section-label is-answer"><CheckOutlined />{t('session_agent.detail.result')}</div>
          <div className="gn-session-agent-answer-provider"><ProviderAvatar providerId={item.providerId} /></div>
          <div className="gn-session-agent-answer-body">
            {assistants.map((message, index) => (
              <AssistantBody key={message.id ?? index} message={message} item={item} />
            ))}
          </div>
        </section>
      ) : null}
      {hasTools || turn.aborted ? (
        <ExecSection
          blocks={blocks}
          stepCount={turn.stepCount}
          errorCount={turn.errorCount}
          fileCount={turnFileCount(messages)}
          aborted={turn.aborted}
          defaultOpen={searching}
          onOpenFull={onOpenFull}
        />
      ) : null}
      {systems.length ? (
        <details className="gn-session-agent-system-events">
          <summary>{t('session_agent.detail.system')}</summary>
          {systems.map((message, index) => <pre key={message.id ?? index}>{message.content}</pre>)}
        </details>
      ) : null}
    </article>
  );
};

const hasAssistantContent = (message: SessionMessageView): boolean =>
  Boolean(message.content || message.structured || (message.blocks ?? []).some((block) =>
    block.type === 'text' || block.type === 'thinking' || block.type === 'image'));

const AssistantBody: React.FC<{ message: SessionMessageView; item: SessionAgentItem }> = ({ message, item }) => {
  const blocks = message.blocks ?? [];
  return (
    <div className="gn-session-agent-assistant-message">
      {blocks.filter((block) => block.type === 'thinking').map((block, index) => <ThinkingRow key={index} block={block} />)}
      {blocks.filter((block) => block.type === 'image' && block.image).map((block, index) => (
        block.image?.path ? (
          <SessionAgentImage key={`img-${index}`} path={block.image.path} alt={block.image.alt} />
        ) : block.image?.content ? (
          <SessionAgentInlineImage
            key={`img-inline-${index}`}
            provider={item.providerId}
            sourcePath={item.sourcePath}
            contentRef={block.image.content}
            mediaType={block.image.mediaType || 'image/png'}
            alt={block.image.alt}
          />
        ) : null
      ))}
      {message.structured ? <SessionAgentStructuredBody body={message.structured} /> : message.content ? (
        <div className="gn-session-agent-atext"><SessionAgentMarkdown content={message.content} /></div>
      ) : null}
      {blocks.filter((block) => block.type === 'text' && block.text?.text).map((block, index) => (
        <div className="gn-session-agent-atext" key={`text-${index}`}><SessionAgentMarkdown content={block.text!.text} /></div>
      ))}
    </div>
  );
};

const ThinkingRow: React.FC<{ block: SessionBlockView }> = ({ block }) => {
  const thinking = block.thinking;
  if (!thinking || thinking.redacted || !thinking.text.trim()) return null;
  return (
    <details className="gn-session-agent-thinking">
      <summary>{t('session_agent.detail.thinking')}</summary>
      <div className="gn-session-agent-thinking-text">{thinking.text}</div>
    </details>
  );
};
