import type { AIChatMessage, AIToolCall } from '../types';
import {
  appendAIChatAttachmentsToContent,
  type AIChatAttachmentTranslator,
} from '../components/ai/aiChatAttachments';

export interface AIRequestMessage {
  role: AIChatMessage['role'];
  content: string;
  images?: string[];
  tool_calls?: AIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

const LEAKED_TOOL_CALL_MARKER = /(?:\\?<\s*tool_call\b|&lt;\s*tool_call\b)/i;
const LEAKED_TOOL_ARGUMENT_MARKER = /(?:\\?<\s*(?:arg_key|arg_value)\b|&lt;\s*(?:arg_key|arg_value)\b)/i;
const KNOWN_LEGACY_RUNTIME_ERROR = /(?:context deadline exceeded|client\.timeout|context cancellation|while reading body|openai responses (?:streaming response|request) failed|rpc failure|stream disconnected|connection (?:reset|refused)|econn(?:reset|refused)|unexpected eof)/i;
const UI_ONLY_MESSAGE_DETAIL_SENTINEL = '__GONAVI_UI_ERROR_DETAIL__';
const LEGACY_UI_ONLY_ASSISTANT_MESSAGES = [
  {
    key: 'ai_chat.panel.message.error',
    fallback: `❌ Error: ${UI_ONLY_MESSAGE_DETAIL_SENTINEL}`,
    dynamic: true,
  },
  {
    key: 'ai_chat.panel.message.send_failed',
    fallback: `❌ Send failed: ${UI_ONLY_MESSAGE_DETAIL_SENTINEL}`,
    dynamic: true,
  },
  {
    key: 'ai_chat.panel.message.empty_response',
    fallback: '❌ The model did not return any content. It may have hit rate limits, context overload, or a refusal.',
    dynamic: false,
  },
  {
    key: 'ai_chat.panel.message.request_interrupted',
    fallback: '❌ Request interrupted: no concrete reply was received.',
    dynamic: false,
  },
] as const;

export const preflightAIToolCallArguments = (
  toolCalls: readonly AIToolCall[],
): AIToolCall[] | null => {
  const normalized: AIToolCall[] = [];

  for (const toolCall of toolCalls) {
    const rawArguments = toolCall?.function?.arguments;
    if (typeof rawArguments !== 'string') return null;

    const trimmedArguments = rawArguments.trim();
    if (trimmedArguments === '') {
      normalized.push({
        ...toolCall,
        function: {
          ...toolCall.function,
          arguments: '{}',
        },
      });
      continue;
    }

    try {
      const parsedArguments: unknown = JSON.parse(trimmedArguments);
      if (
        parsedArguments === null
        || typeof parsedArguments !== 'object'
        || Array.isArray(parsedArguments)
      ) {
        return null;
      }
    } catch {
      return null;
    }

    normalized.push(toolCall);
  }

  return normalized;
};

export const stripLeakedToolCallMarkup = (content: string): string => {
  const text = String(content || '');
  const markerIndex = text.search(LEAKED_TOOL_CALL_MARKER);
  if (markerIndex < 0) {
    return text;
  }

  const hasFollowingArgumentMarker = text
    .slice(markerIndex + 1)
    .search(LEAKED_TOOL_ARGUMENT_MARKER) >= 0;
  return hasFollowingArgumentMarker ? text.slice(0, markerIndex).trimEnd() : text;
};

const matchesUIOnlyMessageTemplate = (content: string, template: string): boolean => {
  const detailIndex = template.indexOf(UI_ONLY_MESSAGE_DETAIL_SENTINEL);
  if (detailIndex < 0) {
    return content === template;
  }

  const prefix = template.slice(0, detailIndex);
  const suffix = template.slice(detailIndex + UI_ONLY_MESSAGE_DETAIL_SENTINEL.length);
  return prefix.length > 0 && content.startsWith(prefix) && content.endsWith(suffix);
};

const isLegacyUIOnlyAssistantMessage = (
  message: AIChatMessage,
  toolResultCallIds: ReadonlySet<string>,
  translate?: AIChatAttachmentTranslator,
): boolean => {
  if (message.role !== 'assistant') {
    return false;
  }

  const content = String(message.content || '');
  const hasOrphanToolCall = (message.tool_calls || [])
    .some((toolCall) => !toolResultCallIds.has(toolCall.id));
  const hasKnownRuntimeError = KNOWN_LEGACY_RUNTIME_ERROR.test(content);
  const looksLikeCrossLocaleRuntimeError = /^\s*❌[^\r\n]*$/u.test(content)
    && hasKnownRuntimeError;

  return LEGACY_UI_ONLY_ASSISTANT_MESSAGES.some(({ key, fallback, dynamic }) => {
    const translated = translate?.(key, { detail: UI_ONLY_MESSAGE_DETAIL_SENTINEL });
    const templates: string[] = [fallback];
    if (translated && translated !== key && translated !== fallback) {
      templates.push(translated);
    }
    const matchesKnownTemplate = templates
      .some((template) => matchesUIOnlyMessageTemplate(content, template));
    if (!dynamic) {
      return matchesKnownTemplate;
    }
    return (matchesKnownTemplate || looksLikeCrossLocaleRuntimeError)
      && (hasKnownRuntimeError || hasOrphanToolCall);
  });
};

export const toAIRequestMessage = (
  message: AIChatMessage,
  translate?: AIChatAttachmentTranslator,
): AIRequestMessage => {
  const content = appendAIChatAttachmentsToContent(message.content, message.attachments, translate);
  const payload: AIRequestMessage = {
    role: message.role,
    content: message.role === 'assistant' ? stripLeakedToolCallMarkup(content) : content,
  };

  if (message.images && message.images.length > 0) {
    payload.images = message.images;
  }
  if (message.tool_calls && message.tool_calls.length > 0) {
    payload.tool_calls = message.tool_calls;
  }
  if (message.tool_call_id) {
    payload.tool_call_id = message.tool_call_id;
  }
  if (message.role === 'assistant' && message.reasoning_content) {
    payload.reasoning_content = message.reasoning_content;
  }

  return payload;
};

export const toAIRequestMessages = (
  messages: AIChatMessage[],
  translate?: AIChatAttachmentTranslator,
): AIRequestMessage[] => {
  const payloads: AIRequestMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const hasToolCalls = message.role === 'assistant' && (message.tool_calls?.length || 0) > 0;

    if (hasToolCalls) {
      let groupEnd = index + 1;
      while (groupEnd < messages.length && messages[groupEnd].role === 'tool') {
        groupEnd += 1;
      }

      const toolCalls = message.tool_calls || [];
      const normalizedToolCalls = preflightAIToolCallArguments(toolCalls);
      const callIds = (normalizedToolCalls || toolCalls)
        .map((toolCall) => String(toolCall.id || '').trim());
      const callIdSet = new Set(callIds);
      const toolResults = messages.slice(index + 1, groupEnd);
      const resultIds = toolResults.map((toolResult) => String(toolResult.tool_call_id || '').trim());
      const resultIdSet = new Set(resultIds);
      const adjacentToolResultCallIds = new Set(resultIds.filter(Boolean));
      const hasCompleteValidToolTurn = callIds.every(Boolean)
        && callIdSet.size === callIds.length
        && toolResults.length === toolCalls.length
        && toolResults.every((toolResult) => toolResult.excludeFromAIContext !== true)
        && resultIds.every(Boolean)
        && resultIdSet.size === resultIds.length
        && resultIds.every((callId) => callIdSet.has(callId));

      if (
        message.excludeFromAIContext === true
        || isLegacyUIOnlyAssistantMessage(message, adjacentToolResultCallIds, translate)
        || normalizedToolCalls === null
        || !hasCompleteValidToolTurn
      ) {
        index = groupEnd - 1;
        continue;
      }

      payloads.push(toAIRequestMessage({
        ...message,
        tool_calls: normalizedToolCalls,
      }, translate));
      payloads.push(...toolResults.map((toolResult) => toAIRequestMessage(toolResult, translate)));
      index = groupEnd - 1;
      continue;
    }

    if (message.role === 'tool') {
      continue;
    }

    if (
      message.excludeFromAIContext === true
      || isLegacyUIOnlyAssistantMessage(message, new Set(), translate)
    ) {
      continue;
    }
    payloads.push(toAIRequestMessage(message, translate));
  }

  return payloads;
};
