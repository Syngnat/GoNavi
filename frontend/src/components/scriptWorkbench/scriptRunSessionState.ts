import type {
  ScriptAuditEntry,
  ScriptLogEntry,
  ScriptOutputPage,
  ScriptRunEvent,
  ScriptRunProgress,
  ScriptRunResult,
  ScriptRunStatus,
} from './scriptWorkbenchTypes';
import {
  SCRIPT_MAX_LOG_ENTRIES,
  SCRIPT_MAX_OUTPUT_STREAMS,
} from './scriptWorkbenchTypes';

const MAX_AUDIT_ENTRIES = 500;

export interface ScriptRunSessionState {
  status: ScriptRunStatus;
  progress: ScriptRunProgress | null;
  result: ScriptRunResult | null;
  outputs: ScriptOutputPage[];
  selectedOutputId: string | null;
  logs: ScriptLogEntry[];
  audits: ScriptAuditEntry[];
  auditsTruncated: boolean;
  logsTruncated: boolean;
  outputsTruncated: boolean;
}

export const initialScriptRunSessionState: ScriptRunSessionState = {
  status: 'idle',
  progress: null,
  result: null,
  outputs: [],
  selectedOutputId: null,
  logs: [],
  audits: [],
  auditsTruncated: false,
  logsTruncated: false,
  outputsTruncated: false,
};

export type ScriptRunSessionAction =
  | { type: 'preparing' }
  | { type: 'cancelling' }
  | { type: 'event'; event: ScriptRunEvent }
  | { type: 'output'; output: ScriptOutputPage }
  | { type: 'select-output'; outputId: string }
  | { type: 'failure'; message: string }
  | { type: 'reset' };

const appendLog = (state: ScriptRunSessionState, log: ScriptLogEntry): ScriptRunSessionState => {
  const logs = [...state.logs, log];
  return {
    ...state,
    logs: logs.slice(-SCRIPT_MAX_LOG_ENTRIES),
    logsTruncated: state.logsTruncated || logs.length > SCRIPT_MAX_LOG_ENTRIES,
  };
};

export const scriptRunSessionReducer = (
  state: ScriptRunSessionState,
  action: ScriptRunSessionAction,
): ScriptRunSessionState => {
  if (action.type === 'preparing') {
    return { ...initialScriptRunSessionState, status: 'preparing' };
  }
  if (action.type === 'cancelling') {
    return { ...state, status: 'cancelling' };
  }
  if (action.type === 'output') {
    return upsertOutput(state, action.output);
  }
  if (action.type === 'select-output') {
    return state.outputs.some((output) => output.outputId === action.outputId)
      ? { ...state, selectedOutputId: action.outputId }
      : state;
  }
  if (action.type === 'failure') {
    return {
      ...state,
      status: 'failed',
      result: { success: false, message: action.message, durationMs: 0 },
    };
  }
  if (action.type === 'reset') return initialScriptRunSessionState;
  if (action.event.type === 'log') {
    return appendLog(state, action.event.log);
  }
  if (action.event.type === 'progress') {
    return {
      ...state,
      status: state.status === 'cancelling' ? 'cancelling' : 'running',
      progress: action.event.progress,
    };
  }
  if (action.event.type === 'output') {
    return upsertOutput(state, action.event.output);
  }
  if (action.event.type === 'audit') {
    return { ...state, audits: [...state.audits, action.event.audit].slice(-MAX_AUDIT_ENTRIES) };
  }
  const result = action.event.result;
  return {
    ...state,
    result,
    auditsTruncated: result.auditsTruncated === true,
    logsTruncated: state.logsTruncated || result.logsTruncated === true,
    outputsTruncated: state.outputsTruncated || result.outputsTruncated === true,
    status: result.outcomeUnknown
      ? 'outcome_unknown'
      : result.timedOut
        ? 'timed_out'
        : result.memoryExceeded
          ? 'memory_exceeded'
          : result.cancelled
            ? 'cancelled'
            : result.success
              ? 'completed'
              : 'failed',
  };
};

const upsertOutput = (
  state: ScriptRunSessionState,
  next: ScriptOutputPage,
): ScriptRunSessionState => {
  const index = state.outputs.findIndex((output) => output.outputId === next.outputId);
  if (index < 0) {
    if (state.outputs.length >= SCRIPT_MAX_OUTPUT_STREAMS) {
      return { ...state, outputsTruncated: true };
    }
    return {
      ...state,
      outputs: [...state.outputs, next],
      selectedOutputId: state.selectedOutputId || next.outputId,
    };
  }
  const previous = state.outputs[index];
  const columns = Array.from(new Set([
    ...previous.columns,
    ...next.columns,
    ...next.rows.flatMap((row) => Object.keys(row)),
  ]));
  const copy = state.outputs.slice();
  copy[index] = { ...next, columns };
  return {
    ...state,
    outputs: copy,
    selectedOutputId: state.selectedOutputId || next.outputId,
  };
};
