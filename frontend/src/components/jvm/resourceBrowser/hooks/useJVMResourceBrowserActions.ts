import type { JVMChangeRequest } from "../../../../types";
import {
  resolveLocalizedErrorMessage,
  buildJVMRuntimeConfig,
  normalizePreviewResult,
  normalizeApplyResult,
} from "../jvmResourceBrowserModel";
import { buildJVMPreviewApplyRequest } from "../../../../utils/jvmResourcePresentation";
import type { JVMResourceBrowserStateApi } from "./useJVMResourceBrowserState";

export interface UseJVMResourceBrowserActionsInput {
  connection: JVMResourceBrowserStateApi['connection'];
  setDraftError: JVMResourceBrowserStateApi['setDraftError'];
  tr: JVMResourceBrowserStateApi['tr'];
  buildDraftPlan: JVMResourceBrowserStateApi['buildDraftPlan'];
  previewSequenceRef: JVMResourceBrowserStateApi['previewSequenceRef'];
  currentPreviewContextKey: JVMResourceBrowserStateApi['currentPreviewContextKey'];
  providerMode: JVMResourceBrowserStateApi['providerMode'];
  setPreviewLoading: JVMResourceBrowserStateApi['setPreviewLoading'];
  setApplyMessage: JVMResourceBrowserStateApi['setApplyMessage'];
  previewContextKeyRef: JVMResourceBrowserStateApi['previewContextKeyRef'];
  clearPreviewState: JVMResourceBrowserStateApi['clearPreviewState'];
  setPreviewResult: JVMResourceBrowserStateApi['setPreviewResult'];
  setPreviewRequest: JVMResourceBrowserStateApi['setPreviewRequest'];
  setPreviewRuntimeConfig: JVMResourceBrowserStateApi['setPreviewRuntimeConfig'];
  setPreviewContextKey: JVMResourceBrowserStateApi['setPreviewContextKey'];
  setPreviewOpen: JVMResourceBrowserStateApi['setPreviewOpen'];
  previewResult: JVMResourceBrowserStateApi['previewResult'];
  previewRequest: JVMResourceBrowserStateApi['previewRequest'];
  previewRuntimeConfig: JVMResourceBrowserStateApi['previewRuntimeConfig'];
  previewContextKey: JVMResourceBrowserStateApi['previewContextKey'];
  setApplyLoading: JVMResourceBrowserStateApi['setApplyLoading'];
  setSnapshot: JVMResourceBrowserStateApi['setSnapshot'];
  loadSnapshot: JVMResourceBrowserStateApi['loadSnapshot'];
}

export const useJVMResourceBrowserActions = ({
  connection, setDraftError, tr, buildDraftPlan, previewSequenceRef, currentPreviewContextKey,
  providerMode, setPreviewLoading, setApplyMessage, previewContextKeyRef, clearPreviewState,
  setPreviewResult, setPreviewRequest, setPreviewRuntimeConfig, setPreviewContextKey,
  setPreviewOpen, previewResult, previewRequest, previewRuntimeConfig, previewContextKey,
  setApplyLoading, setSnapshot, loadSnapshot,
}: UseJVMResourceBrowserActionsInput) => {
  const handlePreview = async () => {
    if (!connection) {
      setDraftError(tr("jvm_resource.error.connection_missing"));
      return;
    }

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMPreviewChange !== "function") {
      setDraftError(tr("jvm_resource.error.preview_unavailable"));
      return;
    }

    let draftPlan: JVMChangeRequest;
    try {
      draftPlan = buildDraftPlan();
    } catch (err) {
      setDraftError(
        resolveLocalizedErrorMessage(
          err,
          tr("jvm_resource.error.draft_invalid"),
        ),
      );
      return;
    }

    const previewSequence = ++previewSequenceRef.current;
    const previewContextKey = currentPreviewContextKey;
    const runtimeConfig = buildJVMRuntimeConfig(connection, providerMode);

    setPreviewLoading(true);
    setDraftError("");
    setApplyMessage("");
    try {
      const result = await backendApp.JVMPreviewChange(
        runtimeConfig,
        draftPlan,
      );
      if (
        previewSequence !== previewSequenceRef.current ||
        previewContextKey !== previewContextKeyRef.current
      ) {
        return;
      }

      if (result?.success === false) {
        clearPreviewState();
        setDraftError(
          String(result?.message || tr("jvm_resource.error.preview_failed")),
        );
        return;
      }

      const preview = normalizePreviewResult(result);
      if (!preview) {
        clearPreviewState();
        setDraftError(tr("jvm_resource.error.preview_result_invalid"));
        return;
      }

      setPreviewResult(preview);
      setPreviewRequest(draftPlan);
      setPreviewRuntimeConfig(runtimeConfig);
      setPreviewContextKey(previewContextKey);
      setPreviewOpen(true);
    } catch (err: any) {
      clearPreviewState();
      setDraftError(
        err?.message ||
          (typeof err === "string" ? err : "") ||
          tr("jvm_resource.error.preview_failed"),
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    await Promise.resolve();

    if (!connection) {
      setDraftError(tr("jvm_resource.error.connection_missing"));
      return;
    }

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMApplyChange !== "function") {
      setDraftError(tr("jvm_resource.error.apply_unavailable"));
      return;
    }

    if (!previewResult || !previewRequest || !previewRuntimeConfig) {
      setDraftError(tr("jvm_resource.error.preview_required"));
      return;
    }
    if (previewContextKey !== previewContextKeyRef.current) {
      clearPreviewState();
      setDraftError(tr("jvm_resource.error.context_changed"));
      return;
    }

    let applyRequest: JVMChangeRequest;
    try {
      applyRequest = buildJVMPreviewApplyRequest(previewRequest, previewResult);
    } catch {
      setDraftError(tr("jvm_resource.error.confirmation_missing"));
      return;
    }

    setApplyLoading(true);
    setDraftError("");
    setApplyMessage("");
    try {
      const result = await backendApp.JVMApplyChange(
        previewRuntimeConfig,
        applyRequest,
      );
      if (result?.success === false) {
        setDraftError(
          String(result?.message || tr("jvm_resource.error.apply_failed")),
        );
        return;
      }

      const applyResult = normalizeApplyResult(result);
      if (applyResult?.updatedValue) {
        setSnapshot(applyResult.updatedValue);
      }

      clearPreviewState();
      setApplyMessage(
        applyResult?.message ||
          result?.message ||
          tr("jvm_resource.message.apply_success"),
      );
      await loadSnapshot();
    } catch (err: any) {
      setDraftError(
        err?.message ||
          (typeof err === "string" ? err : "") ||
          tr("jvm_resource.error.apply_failed"),
      );
    } finally {
      setApplyLoading(false);
    }
  };
  return { handlePreview, handleApply };
};

export type JVMResourceBrowserActionsApi = ReturnType<typeof useJVMResourceBrowserActions>;
