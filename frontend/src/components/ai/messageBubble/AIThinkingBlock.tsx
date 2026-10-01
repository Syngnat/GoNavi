import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CaretRightOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../../i18n/catalog';
import type { I18nParams } from '../../../i18n/types';
import { useOptionalI18n } from '../../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { countThinkingChars, parseThinkingSteps } from '../aiThinkingSteps';

interface AIThinkingBlockProps {
  displayThinking: string;
  isTyping: boolean;
  isGlobalLoading: boolean;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  hasContent: boolean;
}

const ACCENT_COLOR = '#8b5cf6';

const useCopy = () => {
  const i18n = useOptionalI18n();
  return (key: string, params?: I18nParams) => (
    i18n?.t ?? ((catalogKey, catalogParams) => catalogTranslate('en-US', catalogKey, catalogParams))
  )(key, params);
};

/** Bold and inline code only; anything else stays plain text. Stray `**` never shows. */
const renderInline = (text: string): React.ReactNode[] => text
  .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
  .filter(Boolean)
  .map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return <React.Fragment key={index}>{part.replace(/\*\*/g, '')}</React.Fragment>;
  });

export const AIThinkingBlock: React.FC<AIThinkingBlockProps> = ({
  displayThinking,
  isTyping,
  isGlobalLoading,
  darkMode,
  overlayTheme,
  hasContent,
}) => {
  const isActivelyThinking = isGlobalLoading && !hasContent;
  const [expanded, setExpanded] = useState(isActivelyThinking);
  const [openSteps, setOpenSteps] = useState<ReadonlySet<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const copy = useCopy();
  const steps = useMemo(() => parseThinkingSteps(displayThinking), [displayThinking]);
  const charCount = useMemo(() => countThinkingChars(displayThinking), [displayThinking]);

  useEffect(() => {
    if (isActivelyThinking) setExpanded(true);
  }, [isActivelyThinking]);

  useEffect(() => {
    if (!isGlobalLoading) setExpanded(false);
  }, [isGlobalLoading]);

  useEffect(() => {
    if (expanded && isTyping && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayThinking, expanded, isTyping]);

  const toggleStep = (index: number) => setOpenSteps((current) => {
    const next = new Set(current);
    if (!next.delete(index)) next.add(index);
    return next;
  });

  const themeVars = {
    '--ai-think-title': overlayTheme.titleText,
    '--ai-think-muted': overlayTheme.mutedText,
    '--ai-think-accent': ACCENT_COLOR,
    '--ai-think-border': darkMode ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)',
    '--ai-think-surface': darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.018)',
    '--ai-think-hover': darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)',
    '--ai-think-code': darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
  } as React.CSSProperties;

  return (
    <section
      className="ai-think"
      data-testid="ai-thinking-block"
      style={{ ...themeVars, marginBottom: hasContent ? undefined : 0 }}
    >
      <button
        type="button"
        className="ai-think-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {isActivelyThinking
          ? <span className="ai-spinning-ring ai-think-spinner" />
          : <span className="ai-think-dot ai-think-dot-header" />}
        <span className="ai-think-header-title">{copy('ai_chat.message.thinking.title')}</span>
        <span className="ai-think-meta">
          {isActivelyThinking
            ? copy('ai_chat.message.thinking.active')
            : copy('ai_chat.message.thinking.count', { count: charCount })}
        </span>
        <CaretRightOutlined className="ai-think-caret" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }} />
      </button>
      <div className={`ai-expand-transition ${expanded ? 'expanded' : 'collapsed'}`}>
        <div>
          <div ref={scrollRef} className="ai-think-scroll">
            <ol className="ai-think-steps">
              {steps.map((step, index) => {
                const isLast = index === steps.length - 1;
                const typingHere = isTyping && isLast;
                // A titled node with details folds away until it is opened; the
                // node that is still streaming stays open so its text is visible.
                const foldable = Boolean(step.title && step.body);
                const open = !foldable || openSteps.has(index) || typingHere;
                const title = step.title ? renderInline(step.title) : null;
                return (
                  <li key={index} className="ai-think-step" data-active={typingHere ? 'true' : 'false'}>
                    <span className="ai-think-dot" />
                    <div className="ai-think-text">
                      {foldable ? (
                        <button
                          type="button"
                          className="ai-think-node"
                          aria-expanded={open}
                          onClick={() => toggleStep(index)}
                        >
                          <span className="ai-think-title">{title}</span>
                          <CaretRightOutlined className="ai-think-node-caret" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }} />
                        </button>
                      ) : title ? <div className="ai-think-title">{title}</div> : null}
                      {open && step.body
                        ? step.body.split(/\n{2,}/).map((paragraph, paragraphIndex) => (
                          <p key={paragraphIndex} className="ai-think-body">{renderInline(paragraph)}</p>
                        ))
                        : null}
                      {typingHere ? <span className="ai-think-cursor" /> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
};
