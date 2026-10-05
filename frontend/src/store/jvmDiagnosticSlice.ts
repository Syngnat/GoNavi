import type { AppState } from "./storeStateTypes";
import type { StoreGet, StoreSet } from "./storeSliceTypes";

export type JvmDiagnosticSliceState = Pick<AppState, 
  | 'setJVMDiagnosticDraft'
  | 'appendJVMDiagnosticOutput'
  | 'clearJVMDiagnosticOutput'
>;

export const createJvmDiagnosticSlice = (set: StoreSet, _get: StoreGet): JvmDiagnosticSliceState => ({
  setJVMDiagnosticDraft: (tabId, draft) =>
    set((state) => ({
      jvmDiagnosticDrafts: {
        ...state.jvmDiagnosticDrafts,
        [tabId]: {
          command:
            draft.command ??
            state.jvmDiagnosticDrafts[tabId]?.command ??
            "",
          sessionId:
            draft.sessionId ?? state.jvmDiagnosticDrafts[tabId]?.sessionId,
          source: draft.source ?? state.jvmDiagnosticDrafts[tabId]?.source,
          reason: draft.reason ?? state.jvmDiagnosticDrafts[tabId]?.reason,
        },
      },
    })),
  appendJVMDiagnosticOutput: (tabId, chunks) =>
    set((state) => ({
      jvmDiagnosticOutputs: {
        ...state.jvmDiagnosticOutputs,
        [tabId]: [
          ...(state.jvmDiagnosticOutputs[tabId] || []),
          ...chunks,
        ],
      },
    })),
  clearJVMDiagnosticOutput: (tabId) =>
    set((state) => ({
      jvmDiagnosticOutputs: {
        ...state.jvmDiagnosticOutputs,
        [tabId]: [],
      },
    })),
});
