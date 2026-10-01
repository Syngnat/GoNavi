import React, { useEffect, useMemo, useState } from 'react';
import { ApiOutlined, CaretRightOutlined, CheckOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../../i18n/catalog';
import type { I18nParams } from '../../../i18n/types';
import { useOptionalI18n } from '../../../i18n/provider';
import type { AIChatMessage, AIToolCall } from '../../../types';
import type { OverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { TOOL_ACTION_LABEL_KEYS } from '../aiToolActionLabels';
import { describeToolArguments, formatToolResult } from '../aiToolPayloadFormat';
import type { AIToolResultIndex } from '../aiToolResultIndex';

interface AIToolCallingBlockProps {
  toolCalls: AIToolCall[];
  loading: boolean;
  toolResultsById: AIToolResultIndex;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  hasContent: boolean;
}

type Copy = (key: string, params?: I18nParams) => string;

const DONE_COLOR = '#10b981';
const RUNNING_COLOR = '#1677ff';

const useCopy = (): Copy => {
  const i18n = useOptionalI18n();
  return (key, params) => (
    i18n?.t ?? ((catalogKey, catalogParams) => catalogTranslate('en-US', catalogKey, catalogParams))
  )(key, params);
};

const actionLabel = (copy: Copy, toolName: string): string => {
  const key = TOOL_ACTION_LABEL_KEYS[toolName];
  const translated = key ? copy(key) : '';
  return translated && translated !== key ? translated : toolName;
};

const StepStatusIcon: React.FC<{ done: boolean; loading: boolean; mutedColor: string }> = ({ done, loading, mutedColor }) => {
  if (done) return <CheckOutlined style={{ color: DONE_COLOR }} />;
  if (loading) return <span className="ai-spinning-ring ai-probe-spinner" />;
  return <ApiOutlined style={{ color: mutedColor }} />;
};

interface StepProps {
  toolCall: AIToolCall;
  resultMsg: AIChatMessage | undefined;
  loading: boolean;
  copy: Copy;
  mutedColor: string;
}

const AIProbeStep: React.FC<StepProps> = ({ toolCall, resultMsg, loading, copy, mutedColor }) => {
  const [open, setOpen] = useState(false);
  const toolName = toolCall.function.name;
  const label = actionLabel(copy, toolName);
  const args = useMemo(() => describeToolArguments(toolCall.function.arguments), [toolCall.function.arguments]);
  const charCount = resultMsg?.content ? resultMsg.content.length : 0;
  const hasDetail = Boolean(args.primary || resultMsg);
  const resultTitle = copy('ai_chat.message.tool_result.title', { name: resultMsg?.tool_name || toolName });
  const sizeText = !resultMsg
    ? ''
    : charCount > 0
      ? copy('ai_chat.message.tool_result.char_count', { count: charCount.toLocaleString() })
      : copy('ai_chat.message.tool_result.no_data');

  return (
    <div className="ai-probe-step" data-done={resultMsg ? 'true' : 'false'}>
      <button
        type="button"
        className="ai-probe-row"
        aria-expanded={hasDetail ? open : undefined}
        aria-label={resultMsg ? `${label} · ${resultTitle}` : label}
        disabled={!hasDetail}
        onClick={() => setOpen((value) => !value)}
      >
        <StepStatusIcon done={Boolean(resultMsg)} loading={loading} mutedColor={mutedColor} />
        <span className="ai-probe-label">
          <span className="ai-probe-name">{label}</span>
          {label !== toolName ? <code className="ai-probe-tool">{toolName}</code> : null}
        </span>
        <span className="ai-probe-size">{sizeText}</span>
        {hasDetail
          ? <CaretRightOutlined className="ai-probe-caret" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }} />
          : <span className="ai-probe-caret" />}
      </button>
      {open && hasDetail ? (
        <div className="ai-probe-detail">
          {args.primary ? (
            <>
              <pre className="ai-probe-code">{args.primary}</pre>
              {args.meta ? <div className="ai-probe-meta">{args.meta}</div> : null}
            </>
          ) : null}
          {resultMsg ? (
            <>
              <div className="ai-probe-detail-title">{resultTitle}</div>
              <pre className="ai-probe-code">{formatToolResult(resultMsg.content || '')}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const AIToolCallingBlock: React.FC<AIToolCallingBlockProps> = ({
  toolCalls,
  loading,
  toolResultsById,
  darkMode,
  overlayTheme,
  hasContent,
}) => {
  const copy = useCopy();
  const allDone = toolCalls.every((toolCall) => toolResultsById.has(toolCall.id));
  const running = !allDone && loading;
  const [expanded, setExpanded] = useState(running);

  useEffect(() => {
    if (allDone || !loading) setExpanded(false);
  }, [allDone, loading]);

  const themeVars = {
    '--ai-probe-title': overlayTheme.titleText,
    '--ai-probe-muted': overlayTheme.mutedText,
    '--ai-probe-border': darkMode ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)',
    '--ai-probe-divider': darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
    '--ai-probe-surface': darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.018)',
    '--ai-probe-hover': darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)',
    '--ai-probe-code': darkMode ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.04)',
    '--ai-probe-accent': running ? RUNNING_COLOR : DONE_COLOR,
  } as React.CSSProperties;

  return (
    <section
      className="ai-probe"
      data-testid="ai-probe-block"
      data-running={running ? 'true' : 'false'}
      style={{ ...themeVars, marginTop: hasContent ? undefined : 0 }}
    >
      <button
        type="button"
        className="ai-probe-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {running
          ? <span className="ai-spinning-ring ai-probe-spinner" />
          : <CheckOutlined style={{ color: DONE_COLOR }} />}
        <span className="ai-probe-header-title">
          {running ? copy('ai_chat.message.tool_call.running') : copy('ai_chat.message.tool_call.done', { count: toolCalls.length })}
        </span>
        <CaretRightOutlined className="ai-probe-caret" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }} />
      </button>
      <div className={`ai-expand-transition ${expanded ? 'expanded' : 'collapsed'}`}>
        <div>
          <div className="ai-probe-body">
            {toolCalls.map((toolCall) => (
              <AIProbeStep
                key={toolCall.id}
                toolCall={toolCall}
                resultMsg={toolResultsById.get(toolCall.id)}
                loading={loading}
                copy={copy}
                mutedColor={overlayTheme.mutedText}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
