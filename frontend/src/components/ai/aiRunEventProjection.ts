import type { AIToolCall } from '../../types';
import { decodeRawJSONWithStatus } from './aiRawMessage';

export const AI_RUN_EVENT_NAME = 'ai:run:event';
export const AI_RUN_EVENT_SCHEMA_VERSION = 1;

export type AIRunState =
  | 'queued'
  | 'running_model'
  | 'awaiting_approval'
  | 'running_tool'
  | 'awaiting_workspace'
  | 'interrupted'
  | 'recovery_required'
  | 'canceling'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'exhausted';

export type AIRunEventKind =
  | 'input'
  | 'model_delta'
  | 'model_completed'
  | 'tool'
  | 'approval'
  | 'usage'
  | 'checkpoint'
  | 'run_error'
  | 'terminal';

/** Mirrors the immutable Go ToolEffect catalog. */
export type AIRunToolEffect =
  | 'pure'
  | 'read_only'
  | 'idempotent'
  | 'side_effect'
  | 'side_effect_unknown';

export interface AIRunInputPayload {
  requestId: string;
  contentHash?: string;
  dispatchMode?: 'queue' | 'steer';
}

export interface AIRunModelDeltaPayload {
  text?: string;
  reasoning?: string;
  callId?: string;
  toolCalls?: AIRunToolIntent[];
}

export interface AIRunToolIntent {
  callId: string;
  toolName: string;
  arguments?: unknown;
  effect?: AIRunToolEffect;
  argsHash?: string;
}

export interface AIRunModelCompletedPayload {
  text?: string;
  reasoning?: string;
  toolCalls?: AIRunToolIntent[];
  usage?: AIRunUsage;
}

export interface AIRunToolPayload {
  callId: string;
  toolName: string;
  effect: AIRunToolEffect;
  status: string;
  argsHash?: string;
  resultHash?: string;
  errorCode?: string;
  truncated?: boolean;
  originalBytes?: number;
}

export interface AIRunApprovalPayload {
  approvalId: string;
  callId: string;
  toolName: string;
  effect: AIRunToolEffect;
  argsHash: string;
  decision: string;
  /** Server-generated, redacted description of the precise operation. */
  summary?: string;
}

/**
 * UI-safe approval projection. The server emits the exact approval binding
 * and a redacted summary; raw tool arguments never enter this state.
 */
export interface AIRunApprovalState {
  runId: string;
  sessionId: string;
  approvalId: string;
  callId: string;
  decision: string;
  toolName?: string;
  effect?: string;
  argsHash?: string;
  summary?: string;
  revision: number;
}

/** A side-effect outcome that needs an explicit user recovery decision. */
export interface AIRunRecoveryState {
  runId: string;
  sessionId: string;
  callId?: string;
  toolName?: string;
  effect?: string;
  status?: string;
  errorCode?: string;
  reason?: string;
  revision: number;
}

/** A run paused until its bound desktop or CLI workspace source is available. */
export interface AIRunWorkspaceState {
  runId: string;
  sessionId: string;
  revision: number;
}

export interface AIRunUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AIRunUsagePayload {
  usage: AIRunUsage;
}

export interface AIRunCheckpointPayload {
  checkpointId?: string;
  sequence?: number;
}

export interface AIRunErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface AIRunTerminalPayload {
  reason: string;
  errorCode?: string;
}

export type AIRunEventPayload =
  | AIRunInputPayload
  | AIRunModelDeltaPayload
  | AIRunModelCompletedPayload
  | AIRunToolPayload
  | AIRunApprovalPayload
  | AIRunUsagePayload
  | AIRunCheckpointPayload
  | AIRunErrorPayload
  | AIRunTerminalPayload;

export interface AIRunEvent<TPayload extends AIRunEventPayload = AIRunEventPayload> {
  schemaVersion: number;
  runId: string;
  sessionId: string;
  sessionGeneration: number;
  sequence: number;
  runRevision: number;
  attempt: number;
  timestamp: string | number;
  kind: AIRunEventKind;
  resultingState: AIRunState;
  payload: TPayload;
}

const RUN_STATES = new Set<AIRunState>([
  'queued',
  'running_model',
  'awaiting_approval',
  'running_tool',
  'awaiting_workspace',
  'interrupted',
  'recovery_required',
  'canceling',
  'completed',
  'failed',
  'canceled',
  'exhausted',
]);

const EVENT_KINDS = new Set<AIRunEventKind>([
  'input',
  'model_delta',
  'model_completed',
  'tool',
  'approval',
  'usage',
  'checkpoint',
  'run_error',
  'terminal',
]);

const TOOL_EFFECTS = new Set<AIRunToolEffect>([
  'pure',
  'read_only',
  'idempotent',
  'side_effect',
  'side_effect_unknown',
]);

export const isAIRunTerminalState = (state: AIRunState): boolean =>
  state === 'completed'
  || state === 'failed'
  || state === 'canceled'
  || state === 'exhausted';

const toNonNegativeInteger = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
};

const requiredString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
};

const optionalString = (value: unknown): string | undefined | null => {
  if (value === undefined) return undefined;
  return requiredString(value);
};

const optionalBoolean = (value: unknown): boolean | undefined | null => {
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? value : null;
};

/**
 * Provider deltas can arrive before the Go catalog has filled an effect. The
 * omission is safe, but a supplied value must be one of the catalog effects.
 */
const optionalToolEffect = (value: unknown): AIRunToolEffect | undefined | null => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return TOOL_EFFECTS.has(normalized as AIRunToolEffect)
    ? normalized as AIRunToolEffect
    : null;
};

const requiredToolEffect = (value: unknown): AIRunToolEffect | null => {
  const effect = optionalToolEffect(value);
  return effect || null;
};

const parseUsage = (value: unknown): AIRunUsage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const usage: AIRunUsage = {};
  for (const [source, target] of [
    ['promptTokens', 'promptTokens'],
    ['completionTokens', 'completionTokens'],
    ['totalTokens', 'totalTokens'],
  ] as const) {
    if (raw[source] === undefined) continue;
    const count = toNonNegativeInteger(raw[source]);
    if (count === null) return null;
    usage[target] = count;
  }
  return usage;
};

const parsePayload = (value: unknown): Record<string, unknown> | null => {
  if (value === undefined || value === null || value === '') return {};
  const decoded = decodeRawJSONWithStatus(value);
  if (!decoded.valid) return null;
  const parsed = decoded.value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
};

const parseToolIntentList = (value: unknown): AIRunToolIntent[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const intents: AIRunToolIntent[] = [];
  for (const candidate of value) {
    const intent = normalizeAIRunToolIntent(candidate);
    if (!intent || seen.has(intent.callId)) return null;
    seen.add(intent.callId);
    intents.push(intent);
  }
  return intents;
};

const parseModelPayload = (
  raw: Record<string, unknown>,
  completed: boolean,
): AIRunModelDeltaPayload | AIRunModelCompletedPayload | null => {
  const text = optionalStringAllowEmpty(raw.text);
  const reasoning = optionalStringAllowEmpty(raw.reasoning);
  const callId = completed ? undefined : optionalString(raw.callId);
  if (text === null || reasoning === null || callId === null) return null;
  const toolCalls = parseToolIntentList(raw.toolCalls);
  if (toolCalls === null) return null;

  const payload: AIRunModelDeltaPayload | AIRunModelCompletedPayload = {};
  if (text !== undefined) payload.text = text;
  if (reasoning !== undefined) payload.reasoning = reasoning;
  if (!completed && callId !== undefined) (payload as AIRunModelDeltaPayload).callId = callId;
  if (raw.toolCalls !== undefined) payload.toolCalls = toolCalls;
  if (completed && raw.usage !== undefined) {
    const usage = parseUsage(raw.usage);
    if (!usage) return null;
    (payload as AIRunModelCompletedPayload).usage = usage;
  }
  return payload;
};

const optionalStringAllowEmpty = (value: unknown): string | undefined | null => {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
};

const parseTypedPayload = (
  kind: AIRunEventKind,
  raw: Record<string, unknown>,
): AIRunEventPayload | null => {
  switch (kind) {
    case 'input': {
      const requestId = requiredString(raw.requestId);
      const contentHash = optionalString(raw.contentHash);
      if (!requestId || contentHash === null) return null;
      if (raw.dispatchMode !== undefined && raw.dispatchMode !== 'queue' && raw.dispatchMode !== 'steer') {
        return null;
      }
      return {
        requestId,
        ...(contentHash ? { contentHash } : {}),
        ...(raw.dispatchMode ? { dispatchMode: raw.dispatchMode } : {}),
      };
    }
    case 'model_delta':
      return parseModelPayload(raw, false);
    case 'model_completed':
      return parseModelPayload(raw, true);
    case 'tool': {
      const callId = requiredString(raw.callId);
      const toolName = requiredString(raw.toolName);
      const effect = requiredToolEffect(raw.effect);
      const status = requiredString(raw.status);
      const argsHash = optionalString(raw.argsHash);
      const resultHash = optionalString(raw.resultHash);
      const errorCode = optionalString(raw.errorCode);
      const truncated = optionalBoolean(raw.truncated);
      const originalBytes = raw.originalBytes === undefined
        ? undefined
        : toNonNegativeInteger(raw.originalBytes);
      if (
        !callId || !toolName || !effect || !status
        || argsHash === null || resultHash === null || errorCode === null
        || truncated === null || originalBytes === null
      ) return null;
      return {
        callId,
        toolName,
        effect,
        status,
        ...(argsHash ? { argsHash } : {}),
        ...(resultHash ? { resultHash } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
        ...(originalBytes !== undefined ? { originalBytes } : {}),
      };
    }
    case 'approval': {
      const approvalId = requiredString(raw.approvalId);
      const callId = requiredString(raw.callId);
      const toolName = requiredString(raw.toolName);
      const effect = requiredToolEffect(raw.effect);
      const argsHash = requiredString(raw.argsHash);
      const decision = requiredString(raw.decision);
      const summary = optionalStringAllowEmpty(raw.summary);
      if (!approvalId || !callId || !toolName || !effect || !argsHash || !decision || summary === null) {
        return null;
      }
      return {
        approvalId,
        callId,
        toolName,
        effect,
        argsHash,
        decision,
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    case 'usage': {
      const usage = parseUsage(raw.usage);
      return usage ? { usage } : null;
    }
    case 'checkpoint': {
      // CheckpointEvent.CheckpointID intentionally has no omitempty in Go.
      // State-only checkpoints therefore carry an empty string, which is a
      // valid typed payload rather than malformed transport data.
      const checkpointId = optionalStringAllowEmpty(raw.checkpointId);
      const sequence = raw.sequence === undefined ? undefined : toNonNegativeInteger(raw.sequence);
      if (checkpointId === null || sequence === null) return null;
      return {
        ...(checkpointId !== undefined ? { checkpointId } : {}),
        ...(sequence !== undefined ? { sequence } : {}),
      };
    }
    case 'run_error': {
      const code = requiredString(raw.code);
      const message = requiredString(raw.message);
      const retryable = optionalBoolean(raw.retryable);
      if (!code || !message || retryable === null) return null;
      return { code, message, ...(retryable !== undefined ? { retryable } : {}) };
    }
    case 'terminal': {
      const reason = requiredString(raw.reason);
      const errorCode = optionalString(raw.errorCode);
      if (!reason || errorCode === null) return null;
      return { reason, ...(errorCode ? { errorCode } : {}) };
    }
    default:
      return null;
  }
};

export const parseAIRunEvent = (value: unknown): AIRunEvent | null => {
  const decoded = decodeRawJSONWithStatus(value);
  if (!decoded.valid) return null;
  if (!decoded.value || typeof decoded.value !== 'object' || Array.isArray(decoded.value)) return null;
  const raw = decoded.value as Record<string, unknown>;
  const schemaVersion = toNonNegativeInteger(raw.schemaVersion);
  const sessionGeneration = toNonNegativeInteger(raw.sessionGeneration);
  const sequence = toNonNegativeInteger(raw.sequence);
  const runRevision = toNonNegativeInteger(raw.runRevision);
  const attempt = toNonNegativeInteger(raw.attempt);
  const runId = requiredString(raw.runId);
  const sessionId = requiredString(raw.sessionId);
  const kind = requiredString(raw.kind) as AIRunEventKind | null;
  const resultingState = requiredString(raw.resultingState) as AIRunState | null;
  const rawPayload = parsePayload(raw.payload);

  if (
    schemaVersion !== AI_RUN_EVENT_SCHEMA_VERSION
    || !runId
    || !sessionId
    || sessionGeneration === null
    || sequence === null
    || sequence < 1
    || runRevision === null
    || attempt === null
    || kind === null
    || !EVENT_KINDS.has(kind)
    || resultingState === null
    || !RUN_STATES.has(resultingState)
    || rawPayload === null
  ) {
    return null;
  }

  const payload = parseTypedPayload(kind, rawPayload);
  if (payload === null) return null;

  const terminalState = isAIRunTerminalState(resultingState);
  if ((kind === 'terminal') !== terminalState) return null;

  const timestamp = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
    ? raw.timestamp
    : requiredString(raw.timestamp);
  if (timestamp === null) return null;

  return {
    schemaVersion,
    runId,
    sessionId,
    sessionGeneration,
    sequence,
    runRevision,
    attempt,
    timestamp,
    kind,
    resultingState,
    payload,
  };
};

export type AIRunSequenceDecision =
  | { disposition: 'accepted'; event: AIRunEvent }
  | { disposition: 'duplicate' | 'late_terminal'; event: AIRunEvent }
  | { disposition: 'gap'; event: AIRunEvent; afterSequence: number };

interface AIRunSequenceState {
  lastSequence: number;
  terminal: boolean;
}

/**
 * Enforces the durable event ordering contract before UI state is mutated.
 * Gaps are deliberately not advanced; callers must replay from afterSequence.
 */
export class AIRunEventSequenceTracker {
  private readonly runs = new Map<string, AIRunSequenceState>();

  observe(event: AIRunEvent): AIRunSequenceDecision {
    const current = this.runs.get(event.runId) || { lastSequence: 0, terminal: false };
    if (current.terminal) {
      return { disposition: 'late_terminal', event };
    }
    if (event.sequence <= current.lastSequence) {
      return { disposition: 'duplicate', event };
    }
    if (event.sequence !== current.lastSequence + 1) {
      return {
        disposition: 'gap',
        event,
        afterSequence: current.lastSequence,
      };
    }

    const terminal = event.kind === 'terminal' || isAIRunTerminalState(event.resultingState);
    this.runs.set(event.runId, { lastSequence: event.sequence, terminal });
    return { disposition: 'accepted', event };
  }

  lastSequence(runId: string): number {
    return this.runs.get(runId)?.lastSequence || 0;
  }

  reset(runId?: string): void {
    if (runId) {
      this.runs.delete(runId);
      return;
    }
    this.runs.clear();
  }
}

// Keep the event cursor shared when the docked and detached presentations are
// mounted at the same time. Both views can subscribe to Wails events, but a
// durable event must only be projected into the store once.
export const sharedAIRunEventSequenceTracker = new AIRunEventSequenceTracker();

const isToolIntentRecord = (value: unknown): value is AIRunToolIntent => Boolean(
  value
  && typeof value === 'object'
  && !Array.isArray(value),
);

/**
 * Tool arguments are part of the trusted UI projection. Keep only structured
 * JSON values; a partial JSON/XML fragment must never become a visible or
 * executable-looking tool call. IDs are unique within one model turn.
 */
export const normalizeAIRunToolIntent = (value: unknown): AIRunToolIntent | null => {
  if (!isToolIntentRecord(value)) return null;
  const id = requiredString(value.callId);
  const name = requiredString(value.toolName);
  if (!id || !name) return null;

  const effect = optionalToolEffect(value.effect);
  const argsHash = optionalString(value.argsHash);
  if (effect === null || argsHash === null) return null;

  let argumentsValue: Record<string, unknown> | undefined;
  if (value.arguments !== undefined) {
    const decoded = decodeRawJSONWithStatus(value.arguments);
    if (!decoded.valid) return null;
    if (!decoded.value || typeof decoded.value !== 'object' || Array.isArray(decoded.value)) return null;
    try {
      JSON.stringify(decoded.value);
    } catch {
      return null;
    }
    argumentsValue = decoded.value as Record<string, unknown>;
  }

  return {
    callId: id,
    toolName: name,
    ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
    ...(effect ? { effect } : {}),
    ...(argsHash ? { argsHash } : {}),
  };
};

export const toAIRunToolCalls = (payload: AIRunModelCompletedPayload): AIToolCall[] => {
  if (!Array.isArray(payload.toolCalls)) return [];
  const seen = new Set<string>();
  return payload.toolCalls.flatMap((intent) => {
    const normalized = normalizeAIRunToolIntent(intent);
    if (!normalized) return [];
    const id = String(normalized.callId).trim();
    const name = String(normalized.toolName).trim();
    if (seen.has(id)) return [];
    seen.add(id);
    let args = '{}';
    if (normalized.arguments !== undefined) {
      try {
        args = JSON.stringify(normalized.arguments);
      } catch {
        return [];
      }
    }
    return [{
      id,
      type: 'function',
      function: { name, arguments: args },
    }];
  });
};

export const toAIRunEventTimestamp = (value: string | number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
};
