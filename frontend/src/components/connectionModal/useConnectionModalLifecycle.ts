import { useEffect, useMemo, useCallback, useLayoutEffect } from "react";
import { applyNoAutoCapAttributes } from "../../utils/inputAutoCap";
import { CancelConnectionTest } from "../../../wailsjs/go/app/App";
import { getConnectionModalFocusableElements } from "./connectionModalHelpers";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalLifecycleInput {
  open: ConnectionModalProps['open'];
  overlayTheme: ConnectionModalStateApi['overlayTheme'];
  primaryPasswordRevealRequestRef: ConnectionModalStateApi['primaryPasswordRevealRequestRef'];
  revealedPrimaryPasswordRef: ConnectionModalStateApi['revealedPrimaryPasswordRef'];
  form: ConnectionModalStateApi['form'];
  setPrimaryPasswordVisible: ConnectionModalStateApi['setPrimaryPasswordVisible'];
  activeNacosTestRunIdRef: ConnectionModalStateApi['activeNacosTestRunIdRef'];
  testRunIdRef: ConnectionModalStateApi['testRunIdRef'];
  activeTestCancellationRef: ConnectionModalStateApi['activeTestCancellationRef'];
  testTimerRef: ConnectionModalStateApi['testTimerRef'];
  testInFlightRef: ConnectionModalStateApi['testInFlightRef'];
  setTestingConnection: ConnectionModalStateApi['setTestingConnection'];
  setTestResult: ConnectionModalStateApi['setTestResult'];
  setSSHConnectionProgress: ConnectionModalStateApi['setSSHConnectionProgress'];
  setSSHProgressPanelOpen: ConnectionModalStateApi['setSSHProgressPanelOpen'];
  setSSHHostKeyTrust: ConnectionModalStateApi['setSSHHostKeyTrust'];
  onClose: ConnectionModalProps['onClose'];
  setTrustingSSHHostKey: ConnectionModalStateApi['setTrustingSSHHostKey'];
  sshHostKeyTrust: ConnectionModalStateApi['sshHostKeyTrust'];
  sshProgressPanelOpen: ConnectionModalStateApi['sshProgressPanelOpen'];
  sshConnectionProgress: ConnectionModalStateApi['sshConnectionProgress'];
  testErrorLogOpen: ConnectionModalStateApi['testErrorLogOpen'];
  step: ConnectionModalStateApi['step'];
  connectionModalPanelRef: ConnectionModalStateApi['connectionModalPanelRef'];
  initialValues: ConnectionModalProps['initialValues'];
}

export const useConnectionModalLifecycle = ({
  open,
  overlayTheme,
  primaryPasswordRevealRequestRef,
  revealedPrimaryPasswordRef,
  form,
  setPrimaryPasswordVisible,
  activeNacosTestRunIdRef,
  testRunIdRef,
  activeTestCancellationRef,
  testTimerRef,
  testInFlightRef,
  setTestingConnection,
  setTestResult,
  setSSHConnectionProgress,
  setSSHProgressPanelOpen,
  setSSHHostKeyTrust,
  onClose,
  setTrustingSSHHostKey,
  sshHostKeyTrust,
  sshProgressPanelOpen,
  sshConnectionProgress,
  testErrorLogOpen,
  step,
  connectionModalPanelRef,
  initialValues,
}: UseConnectionModalLifecycleInput) => {
  useEffect(() => {
    if (!open) return;
    const applyForConnectionModal = () => {
      document
        .querySelectorAll(
          ".connection-modal-wrap input, .connection-modal-wrap textarea",
        )
        .forEach(applyNoAutoCapAttributes);
    };
    applyForConnectionModal();
    const observer = new MutationObserver(() => {
      applyForConnectionModal();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [open]);

  const modalShellStyle = useMemo(
    () => ({
      background: overlayTheme.shellBg,
      border: overlayTheme.shellBorder,
      boxShadow: overlayTheme.shellShadow,
      backdropFilter: overlayTheme.shellBackdropFilter,
    }),
    [overlayTheme],
  );

  // 弹窗内的区块容器去卡片化：原先是 14px 圆角 + 边框 + 独立底色，
  // 而它同时用在左侧导航容器、右侧内容面板与网络安全的各个分组上，
  // 再叠加内部分组各自的卡片，形成多层「卡片套卡片」，整页视觉噪声很高。
  // 现在只保留内边距，靠内部的小标题与分割线划分层次。
  // 保留原有内边距（间距不变，避免表单贴到容器边缘），只去掉边框、底色与圆角。
  const modalInnerSectionStyle = useMemo(
    () => ({
      padding: 14,
      borderRadius: 0,
      border: "none",
      background: "transparent",
    }),
    [],
  );

  const modalMutedTextStyle = useMemo(
    () => ({
      color: overlayTheme.mutedText,
      fontSize: 12,
      lineHeight: 1.6,
    }),
    [overlayTheme],
  );

  const resetPrimaryPasswordRevealState = useCallback(() => {
    primaryPasswordRevealRequestRef.current += 1;
    revealedPrimaryPasswordRef.current = "";
    form.setFieldValue("password", "");
    setPrimaryPasswordVisible(false);
  }, [form]);

  const cancelActiveConnectionTest = useCallback(() => {
    const nacosTestRunId = activeNacosTestRunIdRef.current;
    activeNacosTestRunIdRef.current = "";

    // Invalidate the current run before rejecting its local wait. This keeps a
    // late Wails response from writing stale success/failure feedback back into
    // a newer editing session.
    testRunIdRef.current += 1;
    const cancelLocalWait = activeTestCancellationRef.current;
    activeTestCancellationRef.current = null;
    if (testTimerRef.current !== null) {
      window.clearTimeout(testTimerRef.current);
      testTimerRef.current = null;
    }
    testInFlightRef.current = false;
    setTestingConnection(false);
    setTestResult(null);
    setSSHConnectionProgress(null);
    setSSHProgressPanelOpen(false);
    setSSHHostKeyTrust(null);
    cancelLocalWait?.();

    if (nacosTestRunId) {
      void CancelConnectionTest(nacosTestRunId).catch(() => undefined);
    }
  }, []);

  const handleModalClose = useCallback(() => {
    cancelActiveConnectionTest();
    resetPrimaryPasswordRevealState();
    setSSHHostKeyTrust(null);
    setTrustingSSHHostKey(false);
    onClose();
  }, [cancelActiveConnectionTest, onClose, resetPrimaryPasswordRevealState]);

  const nestedConnectionModalOpen = Boolean(
    sshHostKeyTrust
    || (sshProgressPanelOpen && sshConnectionProgress)
    || testErrorLogOpen,
  );

  useLayoutEffect(() => {
    if (!open || step === 1 || typeof document === "undefined") return;
    const panel = connectionModalPanelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    const initialFocus = panel.querySelector<HTMLElement>(
      '.gn-conn-form-nav-item[aria-selected="true"]',
    ) || getConnectionModalFocusableElements(panel)[0];
    initialFocus?.focus({ preventScroll: true });
  }, [open, step]);

  useEffect(() => {
    if (
      !open
      || nestedConnectionModalOpen
      || typeof window === "undefined"
      || typeof document === "undefined"
    ) {
      return undefined;
    }

    const keepFocusInConnectionModal = (event: KeyboardEvent) => {
      if (event.key !== "Tab" && event.key !== "Escape") return;
      const panel = connectionModalPanelRef.current;
      if (!panel) return;
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && panel.contains(activeElement)) return;
      const appRoot = document.getElementById("root");
      if (activeElement !== document.body && !appRoot?.contains(activeElement)) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleModalClose();
        return;
      }

      const focusableElements = getConnectionModalFocusableElements(panel);
      const target = event.shiftKey
        ? focusableElements[focusableElements.length - 1]
        : focusableElements[0];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      target.focus({ preventScroll: true });
    };

    window.addEventListener("keydown", keepFocusInConnectionModal, true);
    return () => {
      window.removeEventListener("keydown", keepFocusInConnectionModal, true);
    };
  }, [handleModalClose, nestedConnectionModalOpen, open]);

  useLayoutEffect(() => {
    resetPrimaryPasswordRevealState();
    return () => {
      primaryPasswordRevealRequestRef.current += 1;
      revealedPrimaryPasswordRef.current = "";
      form.setFieldValue("password", "");
    };
  }, [initialValues?.id, open, resetPrimaryPasswordRevealState]);
  return {
    modalShellStyle,
    modalInnerSectionStyle,
    modalMutedTextStyle,
    cancelActiveConnectionTest,
    handleModalClose,
  };
};

export type ConnectionModalLifecycleApi = ReturnType<typeof useConnectionModalLifecycle>;
