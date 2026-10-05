import type { AIChatMessage } from '../../types';
import type { AgentContextPreview } from './aiContextPreviewClient';

/**
 * What the next model turn carries, split by where it came from.
 *
 * The unit is the one the agent harness itself budgets in (see the Go
 * DeterministicContextBuilder): the bytes of each JSON-encoded message. Using the
 * same measure is what makes "100%" mean "earlier messages start being compressed".
 * It is an estimate: the model's own tokenizer counts differently, and the Gateway
 * adds a short policy of its own.
 */

export type AIContextSegmentId = 'instructions' | 'workspace' | 'bound' | 'skills' | 'user' | 'assistant' | 'toolResults';

export const AI_CONTEXT_SEGMENT_ORDER: readonly AIContextSegmentId[] = [
  'instructions', 'workspace', 'bound', 'skills', 'user', 'assistant', 'toolResults',
];

/** The id, session, sequence, role and timestamp that wrap every durable message. */
export const MESSAGE_ENVELOPE_BYTES = 180;

/** The `kind`/`reference` wrapper around the workspace snapshot, which is sent as one string. */
export const WORKSPACE_WRAPPER_BYTES = 320;

/** Bytes of a string as Go's json.Marshal writes it, without the quotes. */
export const jsonStringBytes = (text: string): number => {
  if (!text) return 0;
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20) {
      bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    } else if (ch === '"' || ch === '\\') {
      bytes += 2;
    } else if (ch === '<' || ch === '>' || ch === '&' || code === 0x2028 || code === 0x2029) {
      bytes += 6; // Go escapes these as \u00XX
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code < 0x10000) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
};

export const measureMessageContent = (text: string): number => MESSAGE_ENVELOPE_BYTES + jsonStringBytes(text);

export interface AIHistoryMeasure {
  user: number;
  assistant: number;
  toolResults: number;
  messageCount: number;
  /** The answer being written right now: not stored yet, so Go does not know it. */
  pendingAssistant?: number;
}

const measuredMessages = new WeakMap<AIChatMessage, { role: 'user' | 'assistant' | 'toolResults'; bytes: number } | null>();

/** Messages are replaced, not edited, so a measured one can be remembered while it streams on. */
const measureMessage = (message: AIChatMessage): { role: 'user' | 'assistant' | 'toolResults'; bytes: number } | null => {
  if (measuredMessages.has(message)) return measuredMessages.get(message) ?? null;
  let measured: { role: 'user' | 'assistant' | 'toolResults'; bytes: number } | null = null;
  if (!message.excludeFromAIContext && !message.loading && (message.role === 'user' || message.role === 'assistant' || message.role === 'tool')) {
    const toolCalls = message.tool_calls && message.tool_calls.length > 0 ? JSON.stringify(message.tool_calls).length : 0;
    const bytes = MESSAGE_ENVELOPE_BYTES
      + jsonStringBytes(message.content || '')
      + jsonStringBytes(message.reasoning_content || '')
      + toolCalls;
    measured = { role: message.role === 'tool' ? 'toolResults' : message.role, bytes };
  }
  measuredMessages.set(message, measured);
  return measured;
};

export const measureAIChatHistory = (messages: readonly AIChatMessage[]): AIHistoryMeasure => {
  const result: AIHistoryMeasure = { user: 0, assistant: 0, toolResults: 0, messageCount: 0, pendingAssistant: 0 };
  for (const message of messages) {
    const measured = measureMessage(message);
    if (!measured) {
      if (message.loading && message.role === 'assistant' && !message.excludeFromAIContext && (message.content || message.reasoning_content)) {
        result.pendingAssistant! += MESSAGE_ENVELOPE_BYTES + jsonStringBytes(message.content || '') + jsonStringBytes(message.reasoning_content || '');
      }
      continue;
    }
    result[measured.role] += measured.bytes;
    result.messageCount += 1;
  }
  return result;
};

export type AIContextLevel = 'ok' | 'warn' | 'full';

export interface AIContextBreakdownInput {
  /** The provider's context window. */
  windowSize: number;
  /** Room kept free for the answer. */
  reservedOutput: number;
  /** Workspace snapshot without the bound items. */
  workspaceBytes: number;
  /** Selections, quoted passages and table schemas bound to the next message. */
  boundBytes: number;
  history: AIHistoryMeasure;
  /** What is typed in the composer (attached documents included). */
  draftText: string;
}

export interface AIContextSegment {
  id: AIContextSegmentId;
  size: number;
}

export interface AIContextBreakdown {
  windowSize: number;
  reserved: number;
  /** Window minus the reserved reply: what the prompt may use before compression starts. */
  budget: number;
  used: number;
  free: number;
  /** Earlier messages left out because they no longer fit (known when Go measured it). */
  omittedMessages?: number;
  /** How far the workspace was cut to fit, when it was. */
  workspaceTrimmed?: string;
  /** Even the newest message alone does not fit: sending would be refused. */
  overflow?: boolean;
  /** used / budget, 1 and above meaning compression has started or is about to. */
  pressure: number;
  level: AIContextLevel;
  segments: AIContextSegment[];
}

export const AI_CONTEXT_WARN_PRESSURE = 0.8;

export const buildAIContextBreakdown = (input: AIContextBreakdownInput): AIContextBreakdown => {
  const windowSize = Math.max(1, Math.round(input.windowSize));
  const reserved = Math.min(windowSize, Math.max(0, Math.round(input.reservedOutput)));
  const budget = windowSize - reserved;
  const draft = input.draftText.trim() ? measureMessageContent(input.draftText) : 0;
  const sizes: Record<AIContextSegmentId, number> = {
    // Only Go knows the role prompt and the person's own prompts as they will be sent.
    instructions: 0,
    workspace: Math.max(0, Math.round(input.workspaceBytes)),
    bound: Math.max(0, Math.round(input.boundBytes)),
    // Skills are configured but never added to the agent's context today.
    skills: 0,
    user: input.history.user + draft,
    assistant: input.history.assistant,
    toolResults: input.history.toolResults,
  };
  const segments = AI_CONTEXT_SEGMENT_ORDER.map((id) => ({ id, size: sizes[id] }));
  const used = segments.reduce((sum, segment) => sum + segment.size, 0);
  const pressure = budget > 0 ? used / budget : 1;
  let level: AIContextLevel = 'ok';
  if (pressure >= 1) level = 'full';
  else if (pressure >= AI_CONTEXT_WARN_PRESSURE) level = 'warn';
  return {
    windowSize, reserved, budget, used,
    free: Math.max(0, windowSize - reserved - used),
    pressure, level, segments,
  };
};

/**
 * The breakdown of what Go measured. The window is the one the agent enforces; where
 * it enforces none (a model with a window of its own that the person did not pick a
 * tier for) the panel's own figure is shown, with nothing ever trimmed to it.
 */
export const buildAIContextBreakdownFromPreview = (
  preview: AgentContextPreview,
  fallback: { windowSize: number; reservedOutput: number },
  pendingAssistant = 0,
): AIContextBreakdown => {
  const enforced = preview.windowTokens > 0;
  const windowSize = Math.max(1, Math.round(enforced ? preview.windowTokens : fallback.windowSize));
  const reserved = Math.min(windowSize, Math.max(0, Math.round(enforced ? preview.reservedOutputTokens : fallback.reservedOutput)));
  const budget = windowSize - reserved;
  const sizes: Record<AIContextSegmentId, number> = {
    instructions: preview.instructionsBytes,
    workspace: preview.workspaceBytes,
    bound: preview.boundBytes,
    skills: 0,
    user: preview.userBytes,
    assistant: preview.assistantBytes + Math.max(0, Math.round(pendingAssistant)),
    toolResults: preview.toolBytes,
  };
  const segments = AI_CONTEXT_SEGMENT_ORDER.map((id) => ({ id, size: sizes[id] }));
  const used = segments.reduce((sum, segment) => sum + segment.size, 0);
  const pressure = budget > 0 ? used / budget : 1;
  const level: AIContextLevel = preview.overflow || pressure >= 1 ? 'full' : pressure >= AI_CONTEXT_WARN_PRESSURE ? 'warn' : 'ok';
  return {
    windowSize, reserved, budget, used, free: Math.max(0, budget - used), pressure, level, segments,
    omittedMessages: preview.omittedMessages,
    workspaceTrimmed: preview.workspaceTrimmed,
    overflow: preview.overflow,
  };
};
