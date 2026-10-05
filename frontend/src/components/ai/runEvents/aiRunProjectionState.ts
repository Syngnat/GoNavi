import type { AIChatTokenUsage, AIChatRunActivity } from '../../../types';
import {
  type AIRunToolIntent,
  type AIRunErrorPayload,
  type AIRunState,
  type AIRunEvent,
  sharedAIRunEventSequenceTracker,
} from '../aiRunEventProjection';

export interface ProjectedRun {
  assistantMessageId: string;
  /** Text from model turns that have already crossed their completion boundary. */
  completedModelText: string;
  /** Reasoning from model turns that have already crossed their completion boundary. */
  completedModelReasoning: string;
  /** Text streamed during the currently executing model turn. */
  modelText: string;
  /** Reasoning streamed during the currently executing model turn. */
  modelReasoning: string;
  /** A completed model turn already contributes to this run's single UI row. */
  hasCompletedModelTurn: boolean;
  tokenUsage?: AIChatTokenUsage;
  usageEventSequences: Set<number>;
  /** Prevent the immediately following compatibility usage event from double-counting. */
  lastModelCompletedHadUsage: boolean;
  toolIntents: Map<string, AIRunToolIntent>;
  /** Redacted process steps, kept even when the transient assistant row moves. */
  runActivities: AIChatRunActivity[];
  lastNotifiedRevision: number;
  lastError?: AIRunErrorPayload;
  terminal?: AIRunState;
  terminalHandled?: boolean;
}

export interface ReplayRunProjection {
  /** Number of completed assistant turns already present in the Ledger. */
  durableAssistantTurns: number;
  /** Number of model_completed events consumed during this replay. */
  completedTurns: number;
  /** Protect the turn count when a replay page overlaps the shared cursor. */
  completedEventSequences: Set<number>;
  /** Deltas for the model turn whose completion has not arrived yet. */
  pendingModelEvents: AIRunEvent[];
  /** A live subscriber already projected model text while replay was running. */
  liveModelProjectionSeen: boolean;
}

export const projectedRuns = new Map<string, ProjectedRun>();
export const claimedAssistantMessages = new Map<string, string>();

export const AI_RUN_EVENT_RECOVERY_RETRY_BASE_MS = 100;
export const AI_RUN_EVENT_RECOVERY_RETRY_MAX_MS = 5_000;

export const isAIRunReconciliationState = (state: AIRunState): boolean => (
  state === 'queued'
  || state === 'running_model'
  || state === 'running_tool'
  || state === 'canceling'
);

export const createProjectedRun = (): ProjectedRun => ({
  assistantMessageId: '',
  completedModelText: '',
  completedModelReasoning: '',
  modelText: '',
  modelReasoning: '',
  hasCompletedModelTurn: false,
  lastModelCompletedHadUsage: false,
  usageEventSequences: new Set(),
  toolIntents: new Map(),
  runActivities: [],
  lastNotifiedRevision: -1,
});

export const createReplayRunProjection = (durableAssistantTurns = 0): ReplayRunProjection => ({
  durableAssistantTurns,
  completedTurns: 0,
  completedEventSequences: new Set(),
  pendingModelEvents: [],
  liveModelProjectionSeen: false,
});

/** Reset only the module-level projection cache; intended for isolated tests. */
export const resetAIChatRunEventProjection = (): void => {
  projectedRuns.clear();
  claimedAssistantMessages.clear();
  sharedAIRunEventSequenceTracker.reset();
};

export const payloadObject = <T extends object>(event: AIRunEvent): T => event.payload as T;
