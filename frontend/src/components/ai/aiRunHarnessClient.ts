import type { AIChatAttachment, AIChatMessage, AIToolCall } from '../../types';
import { decodeRawJSON, decodeRawJSONWithStatus } from './aiRawMessage';

export type AIRunDispatchMode = 'queue' | 'steer';
export type AgentTaskKind = 'chat' | 'query_editor_generation';

/** The encrypted ledger attachment envelope accepted by the Go harness. */
export interface AgentAttachment {
  name: string;
  mediaType: string;
  data: string;
}

export interface AgentInputRequest {
  requestId: string;
  sessionId?: string;
  /**
   * Immutable branch cursor. When set, Go creates a new session containing
   * only the source transcript before this durable user message, then appends
   * this request as the replacement/retry turn.
   */
  branchFromMessageId?: string;
  content: string;
  attachments?: AgentAttachment[];
  dispatchMode?: AIRunDispatchMode;
  contextSourceId?: string;
  contextSourceInstanceId?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  temperature?: number;
  maxTokens?: number;
  taskKind?: AgentTaskKind;
  allowTools?: boolean;
  expectedRevision?: number;
}

export interface AgentInputReceipt {
  requestId: string;
  sessionId: string;
  runId: string;
  disposition: 'started' | 'queued' | 'steered' | string;
  revision: number;
  state: string;
}

export type AgentRunControlAction =
  | 'cancel'
  | 'steer'
  | 'approve'
  | 'deny'
  | 'resume'
  | 'recover'
  | 'mark_completed'
  | 'abort_recovery'
  | 'use_stale_workspace';

export interface RunControlRequest {
  requestId: string;
  runId: string;
  sessionId?: string;
  action: AgentRunControlAction;
  callId?: string;
  approvalId?: string;
  /** Exact approval argument digest; required for approve/deny decisions. */
  argsHash?: string;
  content?: string;
  expectedRevision?: number;
}

export interface RunReadRequest {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

export interface RunReadResult {
  run?: Record<string, unknown>;
  events?: unknown[];
  nextSequence?: number;
  hasMore?: boolean;
}

export interface SessionProjectionResult {
  sessionId?: string;
  id?: string;
  title?: string;
  revision?: number;
  generation?: number;
  archived?: boolean;
  createdAt?: string | number;
  updatedAt?: string | number;
  runs?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
}

export const createRunPendingMessageId = (runId: string): string =>
  `agent-run-${runId}-pending`;

export interface SessionListRequest {
  limit?: number;
  offset?: number;
  activeOnly?: boolean;
}

export interface SessionListResult {
  sessions?: SessionProjectionResult[];
  total?: number;
}

export interface SessionReadRequest {
  sessionId: string;
  afterSequence?: number;
  limit?: number;
}

export interface SessionMutationRequest {
  sessionId: string;
  expectedRevision?: number;
  title?: string;
  archived?: boolean;
}

export interface WorkspaceSnapshotRequest {
  schemaVersion: number;
  sourceKind: 'desktop' | 'cli';
  sourceId: string;
  sourceInstanceId: string;
  revision: number;
  capturedAt?: string | number;
  [key: string]: unknown;
}

export interface SnapshotAck {
  sourceId?: string;
  revision?: number;
  contentHash?: string;
  accepted?: boolean;
}

export interface RunPolicySnapshot {
  schemaVersion: number;
  revision: number;
  policy: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

export interface RunPolicyMutationRequest {
  expectedRevision: number;
  policy: Record<string, unknown>;
  runtime: Record<string, unknown>;
}

// Settings only receives a coarse, non-sensitive ledger health projection.
// No path, key source, encrypted data, or diagnostic text belongs in this DTO.
export type AgentLedgerState = 'ready' | 'locked' | 'unavailable';

export interface AgentLedgerStatus {
  state?: string;
}

export interface AIRunHarnessService {
  AISubmitAgentInput?: (request: AgentInputRequest) => Promise<AgentInputReceipt>;
  AIControlAgentRun?: (request: RunControlRequest) => Promise<RunSnapshot>;
  AIReadAgentRun?: (request: RunReadRequest) => Promise<RunReadResult>;
  AIListAgentSessions?: (request: SessionListRequest) => Promise<SessionListResult>;
  AIReadAgentSession?: (request: SessionReadRequest) => Promise<SessionProjectionResult>;
  AIMutateAgentSession?: (request: SessionMutationRequest) => Promise<Record<string, unknown>>;
  AIUpdateWorkspaceSnapshot?: (request: WorkspaceSnapshotRequest) => Promise<SnapshotAck>;
  AIGetRunPolicy?: () => Promise<RunPolicySnapshot>;
  AISaveRunPolicy?: (request: RunPolicyMutationRequest) => Promise<RunPolicySnapshot>;
  AIGetAgentLedgerStatus?: () => Promise<AgentLedgerStatus>;
}

export interface RunSnapshot {
  runId?: string;
  id?: string;
  sessionId?: string;
  state?: string;
  revision?: number;
  sessionGeneration?: number;
  attempt?: number;
  nextSequence?: number;
  [key: string]: unknown;
}

export const getAIRunHarnessService = (): AIRunHarnessService | undefined =>
  (typeof window === 'undefined'
    ? undefined
    : (window as any)?.go?.aiservice?.Service) as AIRunHarnessService | undefined;

export const hasAIRunHarness = (
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): boolean => typeof service?.AISubmitAgentInput === 'function';

const requireMethod = <T extends keyof AIRunHarnessService>(
  service: AIRunHarnessService | undefined,
  method: T,
): NonNullable<AIRunHarnessService[T]> => {
  const implementation = service?.[method];
  if (typeof implementation !== 'function') {
    throw new Error(`${String(method)} is unavailable`);
  }
  return implementation as NonNullable<AIRunHarnessService[T]>;
};

export const submitAgentInput = async (
  request: AgentInputRequest,
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<AgentInputReceipt> => requireMethod(service, 'AISubmitAgentInput')(request);

export const controlAgentRun = async (
  request: RunControlRequest,
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<RunSnapshot> => requireMethod(service, 'AIControlAgentRun')(request);

export const readAgentRun = async (
  request: RunReadRequest,
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<RunReadResult> => requireMethod(service, 'AIReadAgentRun')(request);

export const listAgentSessions = async (
  request: SessionListRequest = {},
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<SessionListResult> => requireMethod(service, 'AIListAgentSessions')(request);

export const readAgentSession = async (
  request: SessionReadRequest,
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<SessionProjectionResult> => requireMethod(service, 'AIReadAgentSession')(request);

export const mutateAgentSession = async (
  request: SessionMutationRequest,
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<Record<string, unknown>> => requireMethod(service, 'AIMutateAgentSession')(request);

export const updateWorkspaceSnapshot = async (
  request: WorkspaceSnapshotRequest,
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<SnapshotAck> => requireMethod(service, 'AIUpdateWorkspaceSnapshot')(request);

export const getRunPolicy = async (
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<RunPolicySnapshot> => requireMethod(service, 'AIGetRunPolicy')();

export const saveRunPolicy = async (
  request: RunPolicyMutationRequest,
  service: AIRunHarnessService | undefined = getAIRunHarnessService(),
): Promise<RunPolicySnapshot> => requireMethod(service, 'AISaveRunPolicy')(request);

export const normalizeAgentLedgerState = (value: unknown): AgentLedgerState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unavailable';
  const state = String((value as AgentLedgerStatus).state || '').trim().toLowerCase();
  return state === 'ready' || state === 'locked' || state === 'unavailable'
    ? state
    : 'unavailable';
};

const parseTimestamp = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Go's time.Duration/int timestamp values are occasionally returned as
    // nanoseconds by Wails. Treat values above the millisecond range as ns.
    return value > 10_000_000_000_000 ? Math.floor(value / 1_000_000) : value;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const stringifyToolArguments = (value: unknown): string | null => {
  if (value === undefined) return '{}';
  const decoded = decodeRawJSONWithStatus(value);
  if (!decoded.valid) return null;
  const source = decoded.value;
  if (source === null || typeof source !== 'object') return null;
  try {
    return JSON.stringify(source) || null;
  } catch {
    return null;
  }
};

export const parseToolCalls = (value: unknown): AIToolCall[] | undefined => {
  const raw = decodeRawJSON(value);
  if (raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const calls = raw.flatMap((item): AIToolCall[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = String(record.callId || record.id || '').trim();
    const name = String(record.toolName || record.name || '').trim();
    if (!id || !name) return [];
    const args = stringifyToolArguments(record.arguments);
    if (args === null) return [];
    return [{
      id,
      type: 'function',
      function: { name, arguments: args },
    }];
  });
  return calls.length > 0 ? calls : undefined;
};

/**
 * Convert the nested UI shortcut shape into the Go snapshot contract
 * (map[string]string).  Flattening preserves both platform bindings and the
 * enabled flag without asking Wails to unmarshal nested objects as strings.
 */
export const serializeShortcutOptionsForWorkspace = (
  value: unknown,
): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [action, binding] of Object.entries(value as Record<string, unknown>)) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      if (typeof binding === 'string' || typeof binding === 'number' || typeof binding === 'boolean') {
        result[action] = String(binding);
      }
      continue;
    }
    for (const platform of ['mac', 'windows']) {
      const platformBinding = (binding as Record<string, unknown>)[platform];
      if (!platformBinding || typeof platformBinding !== 'object' || Array.isArray(platformBinding)) continue;
      const record = platformBinding as Record<string, unknown>;
      if (typeof record.combo === 'string') {
        result[`${action}.${platform}.combo`] = record.combo;
      }
      if (typeof record.enabled === 'boolean') {
        result[`${action}.${platform}.enabled`] = String(record.enabled);
      }
    }
  }
  return result;
};

const appendDurableTurn = (completed: string, current: string): string => {
  if (!current) return completed;
  if (!completed) return current;
  if (completed === current || completed.endsWith(current)) return completed;
  if (current.startsWith(completed)) return current;
  return `${completed.trimEnd()}\n\n${current.trimStart()}`;
};

const mergeDurableToolCalls = (
  existing: AIToolCall[] | undefined,
  incoming: AIToolCall[] | undefined,
): AIToolCall[] | undefined => {
  if (!incoming || incoming.length === 0) return existing;
  const calls = [...(existing || [])];
  const existingIds = new Set(calls.map((call) => call.id));
  for (const call of incoming) {
    if (existingIds.has(call.id)) continue;
    calls.push(call);
    existingIds.add(call.id);
  }
  return calls.length > 0 ? calls : undefined;
};

const mergeDurableAssistant = (target: AIChatMessage, incoming: AIChatMessage): void => {
  target.content = appendDurableTurn(target.content, incoming.content);
  target.reasoning_content = appendDurableTurn(
    String(target.reasoning_content || ''),
    String(incoming.reasoning_content || ''),
  ) || undefined;
  target.tool_calls = mergeDurableToolCalls(target.tool_calls, incoming.tool_calls);
  if (incoming.images?.length) {
    target.images = [...new Set([...(target.images || []), ...incoming.images])];
  }
  if (incoming.attachments?.length) {
    const attachmentIds = new Set((target.attachments || []).map((attachment) => attachment.id));
    target.attachments = [
      ...(target.attachments || []),
      ...incoming.attachments.filter((attachment) => !attachmentIds.has(attachment.id)),
    ];
  }
};

/** Convert an encrypted-ledger session projection into the UI message shape. */
export const toAIChatMessages = (projection: SessionProjectionResult | null | undefined): AIChatMessage[] => {
  if (!projection || !Array.isArray(projection.messages)) return [];
  const messages: AIChatMessage[] = [];
  const assistantByRun = new Map<string, AIChatMessage>();
  projection.messages.forEach((raw): void => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const message = raw as Record<string, unknown>;
    const role = String(message.role || '').trim();
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') return;
    const toolCalls = parseToolCalls(message.toolCalls ?? message.tool_calls);
    const id = String(message.id || '').trim();
    if (!id) return;
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.flatMap((rawAttachment): AIChatAttachment[] => {
        if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) return [];
        const attachment = rawAttachment as Record<string, unknown>;
        const name = String(attachment.name || '').trim();
        if (!name) return [];
        const mimeType = String(attachment.mediaType || attachment.mimeType || 'application/octet-stream');
        const data = String(attachment.data || attachment.dataUrl || attachment.text || '');
        const kind = mimeType.startsWith('image/') ? 'image' : 'document';
        return [{
          id: String(attachment.id || `ledger-att-${id}-${name}`),
          name,
          mimeType,
          size: Number(attachment.size || data.length) || data.length,
          kind,
          ...(data ? { dataUrl: kind === 'image' ? data : undefined, text: kind === 'image' ? undefined : data } : {}),
        }];
      })
      : undefined;
    const uiMessage: AIChatMessage = {
      id,
      ...(String(message.runId || message.RunID || '').trim()
        ? { runId: String(message.runId || message.RunID || '').trim() }
        : {}),
      role,
      content: String(message.content || ''),
      timestamp: parseTimestamp(message.createdAt ?? message.created_at),
      images: Array.isArray(message.images) ? message.images.map(String) : undefined,
      attachments,
      reasoning_content: String(message.reasoning || '').trim() || undefined,
      tool_calls: toolCalls,
      tool_call_id: String(message.toolCallId || message.tool_call_id || '').trim() || undefined,
      loading: false,
      phase: 'idle',
    };
    if (role === 'tool') uiMessage.tool_name = String(message.toolName || '').trim() || undefined;
    if (role === 'assistant' && uiMessage.runId) {
      const existing = assistantByRun.get(uiMessage.runId);
      if (existing) {
        mergeDurableAssistant(existing, uiMessage);
        return;
      }
      assistantByRun.set(uiMessage.runId, uiMessage);
    }
    messages.push(uiMessage);
  });
  return messages;
};

/** Merge a durable projection with transient assistant UI state. */
export const mergeAIChatSessionMessages = (
  durable: AIChatMessage[],
  current: AIChatMessage[],
): AIChatMessage[] => {
  const durableIDs = new Set(durable.map((message) => message.id));
  const durableAssistantContents = new Set(
    durable
      .filter((message) => message.role === 'assistant' && String(message.content || '').length > 0)
      .map((message) => String(message.content)),
  );
  const latestDurableUserTimestamp = durable.reduce(
    (latest, message) => message.role === 'user' ? Math.max(latest, message.timestamp) : latest,
    0,
  );
  const hasDurableAssistantAfterLatestUser = durable.some(
    (message) => message.role === 'assistant'
      && message.timestamp >= latestDurableUserTimestamp
      && String(message.content || '').length > 0,
  );
  const transient = current.filter((message) => (
    message.role === 'assistant'
    && message.loading === true
    && !durableIDs.has(message.id)
    // A run event can create a temporary connecting row before the encrypted
    // assistant message is read back. Once the Ledger contains the same final
    // text, keep only the durable row.
    && !durableAssistantContents.has(String(message.content || ''))
    && !(String(message.content || '') === ''
      && hasDurableAssistantAfterLatestUser
      && message.timestamp >= latestDurableUserTimestamp)
  ));
  // A terminal error is emitted after the assistant's tool-call turn has
  // already been persisted. Keep that run-scoped error across the terminal
  // hydration; otherwise the durable empty tool-call row replaces it and the
  // user sees a blank assistant bubble with no failure explanation.
  const terminalFailures = current.filter((message) => (
    message.role === 'assistant'
    && message.loading === false
    && message.excludeFromAIContext === true
    && /^agent-run-.+-error$/.test(String(message.id || ''))
    && Boolean(String(message.runId || '').trim())
    && Boolean(String(message.rawError || '').trim())
    && !durableIDs.has(message.id)
  ));
  const terminalFailureRunIds = new Set(
    terminalFailures
      .map((message) => String(message.runId || '').trim())
      .filter(Boolean),
  );
  // A failed receipt can add its queued row after the terminal event has
  // already rendered the error. Do not let hydration merge that stale row
  // back into the conversation for the run that is already settled.
  const settledTransient = transient.filter((message) => {
    const runId = String(message.runId || '').trim();
    return !runId || !terminalFailureRunIds.has(runId);
  });
  const candidates = [...settledTransient, ...terminalFailures];
  if (candidates.length === 0) return durable;

  // A terminal/error or pending row belongs immediately after the durable
  // turns for the same run. This is stronger than timestamp ordering because
  // a delayed terminal event can arrive after the next user turn was saved.
  const byRun = new Map<string, Array<{ message: AIChatMessage; index: number }>>();
  const fallback: Array<{ message: AIChatMessage; index: number }> = [];
  candidates.forEach((message, index) => {
    const runId = String(message.runId || '').trim();
    if (!runId) {
      fallback.push({ message, index });
      return;
    }
    const group = byRun.get(runId) || [];
    group.push({ message, index });
    byRun.set(runId, group);
  });
  for (const group of byRun.values()) {
    group.sort((left, right) => left.message.timestamp - right.message.timestamp || left.index - right.index);
  }

  const anchoredRunIds = new Set<string>();
  const lastDurableIndexByRun = new Map<string, number>();
  durable.forEach((message, index) => {
    const runId = String(message.runId || '').trim();
    if (runId) lastDurableIndexByRun.set(runId, index);
  });
  const result: AIChatMessage[] = [];
  durable.forEach((message, index) => {
    result.push(message);
    const runId = String(message.runId || '').trim();
    if (!runId || index !== lastDurableIndexByRun.get(runId)) {
      return;
    }
    const group = byRun.get(runId);
    if (!group) return;
    anchoredRunIds.add(runId);
    result.push(...group.map(({ message: candidate }) => candidate));
  });

  // Legacy local rows, and run-scoped rows whose durable run is not present
  // in this page, keep the previous timestamp fallback.
  const unanchored = [
    ...fallback,
    ...[...byRun.entries()]
      .filter(([runId]) => !anchoredRunIds.has(runId))
      .flatMap(([, group]) => group),
  ].sort((left, right) => left.message.timestamp - right.message.timestamp || left.index - right.index);
  for (const item of unanchored) {
    const insertAt = result.findIndex((candidate) => candidate.timestamp > item.message.timestamp);
    if (insertAt < 0) result.push(item.message);
    else result.splice(insertAt, 0, item.message);
  }
  return result;
};
