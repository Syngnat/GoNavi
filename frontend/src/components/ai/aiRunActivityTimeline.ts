import type {
  AIChatRunActivity,
  AIChatRunActivityKind,
  AIChatRunActivityStatus,
} from '../../types';
import {
  toAIRunEventTimestamp,
  type AIRunApprovalPayload,
  type AIRunErrorPayload,
  type AIRunEvent,
  type AIRunModelCompletedPayload,
  type AIRunToolPayload,
} from './aiRunEventProjection';

const terminalActivityStatus = (state: string): AIChatRunActivityStatus => {
  if (state === 'completed') return 'completed';
  if (state === 'canceled' || state === 'interrupted') return 'canceled';
  return 'failed';
};

const toolActivityStatus = (status: unknown): AIChatRunActivityStatus => {
  switch (String(status || '').trim().toLowerCase()) {
    case 'completed':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'unknown':
      return 'waiting';
    default:
      return 'active';
  }
};

const isInProgress = (activity: AIChatRunActivity): boolean => (
  activity.status === 'active' || activity.status === 'waiting'
);

const updateActivity = (
  activities: AIChatRunActivity[],
  incoming: AIChatRunActivity,
): AIChatRunActivity[] => {
  const index = activities.findIndex((activity) => activity.id === incoming.id);
  if (index < 0) return [...activities, incoming];
  const existing = activities[index];
  const merged = { ...existing, ...incoming, timestamp: existing.timestamp };
  if (
    existing.kind === merged.kind
    && existing.status === merged.status
    && existing.toolName === merged.toolName
    && existing.attempt === merged.attempt
    && existing.errorCode === merged.errorCode
  ) {
    return activities;
  }
  return activities.map((activity, activityIndex) => (
    activityIndex === index ? merged : activity
  ));
};

const latestInProgress = (
  activities: AIChatRunActivity[],
  kind: AIChatRunActivityKind,
): AIChatRunActivity | undefined => (
  [...activities].reverse().find((activity) => activity.kind === kind && isInProgress(activity))
);

const settleInProgress = (
  activities: AIChatRunActivity[],
  status: AIChatRunActivityStatus,
): AIChatRunActivity[] => activities.map((activity) => (
  activity.kind !== 'run' && isInProgress(activity)
    ? { ...activity, status }
    : activity
));

const ensureModelActivity = (
  activities: AIChatRunActivity[],
  event: AIRunEvent,
): AIChatRunActivity[] => {
  if (latestInProgress(activities, 'model')) return activities;
  return updateActivity(activities, {
    id: `model:${event.sequence}`,
    kind: 'model',
    status: 'active',
    timestamp: toAIRunEventTimestamp(event.timestamp),
    attempt: event.attempt > 0 ? event.attempt : undefined,
  });
};

/**
 * Produces a safe, compact process log from immutable harness events. It
 * deliberately accepts only identifiers and status data, never model
 * reasoning, tool arguments, tool results, or provider error messages.
 */
export const projectAIRunActivities = (
  existing: AIChatRunActivity[] | undefined,
  event: AIRunEvent,
): AIChatRunActivity[] => {
  let activities = [...(existing || [])];
  const timestamp = toAIRunEventTimestamp(event.timestamp);

  switch (event.kind) {
    case 'input':
      activities = updateActivity(activities, {
        id: 'run',
        kind: 'run',
        status: 'active',
        timestamp,
        attempt: event.attempt > 0 ? event.attempt : undefined,
      });
      return ensureModelActivity(activities, event);
    case 'model_delta':
      return ensureModelActivity(activities, event);
    case 'model_completed': {
      const activeModel = latestInProgress(activities, 'model');
      activities = updateActivity(activities, {
        id: activeModel?.id || `model:${event.sequence}`,
        kind: 'model',
        status: 'completed',
        timestamp,
        attempt: event.attempt > 0 ? event.attempt : undefined,
      });
      const payload = event.payload as AIRunModelCompletedPayload;
      for (const intent of payload.toolCalls || []) {
        const callId = String(intent.callId || '').trim();
        const toolName = String(intent.toolName || '').trim();
        if (!callId || !toolName) continue;
        activities = updateActivity(activities, {
          id: `tool:${callId}`,
          kind: 'tool',
          status: 'waiting',
          timestamp,
          toolName,
          attempt: event.attempt > 0 ? event.attempt : undefined,
        });
      }
      return activities;
    }
    case 'tool': {
      const payload = event.payload as AIRunToolPayload;
      const callId = String(payload.callId || '').trim();
      const toolName = String(payload.toolName || '').trim();
      const status = toolActivityStatus(payload.status);
      activities = updateActivity(activities, {
        id: callId ? `tool:${callId}` : `tool:${event.sequence}`,
        kind: 'tool',
        status,
        timestamp,
        ...(toolName ? { toolName } : {}),
        attempt: event.attempt > 0 ? event.attempt : undefined,
        ...(status === 'failed' && payload.errorCode ? { errorCode: payload.errorCode } : {}),
      });
      if (status === 'completed' && event.resultingState === 'running_model') {
        activities = ensureModelActivity(activities, event);
      }
      return activities;
    }
    case 'approval': {
      const payload = event.payload as AIRunApprovalPayload;
      const decision = String(payload.decision || '').trim().toLowerCase();
      const approvalId = String(payload.approvalId || '').trim() || String(event.sequence);
      const toolName = String(payload.toolName || '').trim();
      const status: AIChatRunActivityStatus = decision === 'pending'
        ? 'waiting'
        : decision === 'rejected' || decision === 'canceled' || decision === 'cancelled'
          ? 'canceled'
          : 'completed';
      return updateActivity(activities, {
        id: `approval:${approvalId}`,
        kind: 'approval',
        status,
        timestamp,
        ...(toolName ? { toolName } : {}),
      });
    }
    case 'checkpoint':
      if (event.resultingState === 'awaiting_workspace') {
        return updateActivity(activities, {
          id: 'workspace',
          kind: 'workspace',
          status: 'waiting',
          timestamp,
        });
      }
      return activities.map((activity) => (
        activity.kind === 'workspace' && activity.status === 'waiting'
          ? { ...activity, status: 'completed' }
          : activity
      ));
    case 'run_error': {
      const payload = event.payload as AIRunErrorPayload;
      if (event.resultingState === 'recovery_required') {
        return updateActivity(activities, {
          id: `retry:${event.attempt || event.sequence}`,
          kind: 'retry',
          status: 'waiting',
          timestamp,
          attempt: event.attempt > 0 ? event.attempt : undefined,
          ...(payload.code ? { errorCode: payload.code } : {}),
        });
      }
      if (!['failed', 'canceled', 'interrupted', 'exhausted'].includes(event.resultingState)) {
        return activities;
      }
      const status = terminalActivityStatus(event.resultingState);
      activities = settleInProgress(activities, status);
      return updateActivity(activities, {
        id: 'run',
        kind: 'run',
        status,
        timestamp,
        ...(payload.code ? { errorCode: payload.code } : {}),
      });
    }
    case 'terminal': {
      const status = terminalActivityStatus(event.resultingState);
      activities = settleInProgress(activities, status);
      return updateActivity(activities, {
        id: 'run',
        kind: 'run',
        status,
        timestamp,
      });
    }
    default:
      return activities;
  }
};
