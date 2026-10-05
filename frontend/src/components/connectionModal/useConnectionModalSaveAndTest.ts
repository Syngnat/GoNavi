import { message } from "antd";
import { resolveConnectionDriverType } from "../../utils/connectionDriverType";
import {
  buildConnectionConfig,
  buildSavedConnectionInput,
  createEmptyConnectionSecretClearState,
  getBlockingSecretClearMessage,
} from "./connectionModalConfig";
import { t } from "../../i18n";
import { normalizeConnectionSecretErrorMessage } from "../../utils/connectionModalPresentation";
import {
  type TestFailureKind,
  MAX_TIMEOUT_SECONDS,
  extractRedisDatabaseList,
  normalizeRedisDatabaseSelection,
  buildRedisDatabaseList,
} from "./connectionModalHelpers";
import { buildRpcConnectionConfig } from "../../utils/connectionRpcConfig";
import { createSSHConnectionProgress, finishSSHConnectionProgress } from "./sshConnectionProgress";
import {
  TestJVMConnection,
  RedisConnect,
  NacosTestConnectionWithProgress,
  TestConnectionWithProgress,
  TestConnection,
  RedisGetDatabases,
  DBGetDatabases,
} from "../../../wailsjs/go/app/App";
import { readSSHHostKeyTrustDetails } from "./sshHostKeyTrust";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalDriverStatusApi } from "./useConnectionModalDriverStatus";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalSaveAndTestInput {
  initialValues: ConnectionModalProps['initialValues'];
  onSaved: ConnectionModalProps['onSaved'];
  form: ConnectionModalStateApi['form'];
  dbType: ConnectionModalStateApi['dbType'];
  setDbType: ConnectionModalStateApi['setDbType'];
  revealedPrimaryPasswordRef: ConnectionModalStateApi['revealedPrimaryPasswordRef'];
  resolveDriverUnavailableReason: ConnectionModalDriverStatusApi['resolveDriverUnavailableReason'];
  promptInstallDriver: ConnectionModalDriverStatusApi['promptInstallDriver'];
  setSaving: ConnectionModalStateApi['setSaving'];
  oracleModeTouchedRef: ConnectionModalStateApi['oracleModeTouchedRef'];
  clearSecretsRef: ConnectionModalStateApi['clearSecretsRef'];
  customIconType: ConnectionModalStateApi['customIconType'];
  customIconColor: ConnectionModalStateApi['customIconColor'];
  updateConnection: ConnectionModalStateApi['updateConnection'];
  addConnection: ConnectionModalStateApi['addConnection'];
  setUseSSL: ConnectionModalStateApi['setUseSSL'];
  setUseSSH: ConnectionModalStateApi['setUseSSH'];
  setUseProxy: ConnectionModalStateApi['setUseProxy'];
  setUseHttpTunnel: ConnectionModalStateApi['setUseHttpTunnel'];
  setStep: ConnectionModalStateApi['setStep'];
  setClearSecrets: ConnectionModalStateApi['setClearSecrets'];
  handleModalClose: ConnectionModalLifecycleApi['handleModalClose'];
  saving: ConnectionModalStateApi['saving'];
  testingConnection: ConnectionModalStateApi['testingConnection'];
  testTimerRef: ConnectionModalStateApi['testTimerRef'];
  activeTestCancellationRef: ConnectionModalStateApi['activeTestCancellationRef'];
  setTestResult: ConnectionModalStateApi['setTestResult'];
  testInFlightRef: ConnectionModalStateApi['testInFlightRef'];
  testRunIdRef: ConnectionModalStateApi['testRunIdRef'];
  clearSecrets: ConnectionModalStateApi['clearSecrets'];
  setTestingConnection: ConnectionModalStateApi['setTestingConnection'];
  setSSHConnectionProgress: ConnectionModalStateApi['setSSHConnectionProgress'];
  setSSHProgressPanelOpen: ConnectionModalStateApi['setSSHProgressPanelOpen'];
  activeNacosTestRunIdRef: ConnectionModalStateApi['activeNacosTestRunIdRef'];
  setSSHHostKeyTrust: ConnectionModalStateApi['setSSHHostKeyTrust'];
  setRedisDbList: ConnectionModalStateApi['setRedisDbList'];
  setDbList: ConnectionModalStateApi['setDbList'];
}

export const useConnectionModalSaveAndTest = ({
  initialValues,
  onSaved,
  form,
  dbType,
  setDbType,
  revealedPrimaryPasswordRef,
  resolveDriverUnavailableReason,
  promptInstallDriver,
  setSaving,
  oracleModeTouchedRef,
  clearSecretsRef,
  customIconType,
  customIconColor,
  updateConnection,
  addConnection,
  setUseSSL,
  setUseSSH,
  setUseProxy,
  setUseHttpTunnel,
  setStep,
  setClearSecrets,
  handleModalClose,
  saving,
  testingConnection,
  testTimerRef,
  activeTestCancellationRef,
  setTestResult,
  testInFlightRef,
  testRunIdRef,
  clearSecrets,
  setTestingConnection,
  setSSHConnectionProgress,
  setSSHProgressPanelOpen,
  activeNacosTestRunIdRef,
  setSSHHostKeyTrust,
  setRedisDbList,
  setDbList,
}: UseConnectionModalSaveAndTestInput) => {
  const handleOk = async () => {
    try {
      await form.validateFields();
      const formValues = { ...form.getFieldsValue(true), type: dbType };
      const revealedPrimaryPassword = revealedPrimaryPasswordRef.current;
      const values = {
        ...formValues,
        password:
          revealedPrimaryPassword !== "" &&
          String(formValues.password ?? "") === revealedPrimaryPassword
            ? ""
            : formValues.password,
      };
      const unavailableReason = await resolveDriverUnavailableReason(
        values.type,
        values.driver,
      );
      if (unavailableReason) {
        message.warning(unavailableReason);
        promptInstallDriver(
          resolveConnectionDriverType(values.type, values.driver) || values.type,
          unavailableReason,
        );
        return;
      }
      setSaving(true);

      const config = await buildConnectionConfig({
        values,
        forPersist: true,
        initialValues,
        nacosNamespaceIdTouched:
          form.isFieldTouched?.("nacosNamespaceId") === true,
        oracleModeTouched: oracleModeTouchedRef.current,
        translate: t,
      });
      const payload = buildSavedConnectionInput({
        config,
        values,
        initialValues,
        clearSecrets: clearSecretsRef.current,
        customIconType,
        customIconColor,
      });
      const backendApp = (window as any).go?.app?.App;
      const savedConnection = await backendApp?.SaveConnection?.(payload);
      if (!savedConnection) {
        throw new Error(t("connection.modal.save.backendUnavailable"));
      }

      if (initialValues) {
        updateConnection(savedConnection);
        message.success(t("connection.modal.save.updatedUnconnected"));
      } else {
        addConnection(savedConnection);
        message.success(t("connection.modal.save.savedUnconnected"));
      }

      if (onSaved) {
        void Promise.resolve(onSaved(savedConnection)).catch(
          (error: unknown) => {
            console.warn("Failed to refresh post-save state", error);
            void message.warning(
              t("connection.modal.save.refreshWarning"),
            );
          },
        );
      }

      form.resetFields();
      setUseSSL(false);
      setUseSSH(false);
      setUseProxy(false);
      setUseHttpTunnel(false);
      setDbType("mysql");
      setStep(1);
      const emptyClearSecrets = createEmptyConnectionSecretClearState();
      clearSecretsRef.current = emptyClearSecrets;
      setClearSecrets(emptyClearSecrets);
      handleModalClose();
    } catch (e: any) {
      message.error(
        normalizeConnectionSecretErrorMessage(
          e?.message || e,
          t("connection.modal.save.failureFallback"),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const requestTest = () => {
    if (saving || testingConnection) return;
    if (testTimerRef.current !== null) return;
    testTimerRef.current = window.setTimeout(() => {
      testTimerRef.current = null;
      handleTest();
    }, 0);
  };

  const withClientTimeout = async <T,>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> => {
    let timer: number | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(timeoutMessage)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
  };

  const makeCancellableConnectionTestRequest = <T,>(promise: Promise<T>) => {
    let rejectCancellation: ((reason?: unknown) => void) | null = null;
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      rejectCancellation?.(new Error("connection test cancelled"));
    };
    activeTestCancellationRef.current = cancel;
    return {
      promise: Promise.race([promise, cancellation]),
      cancel,
    };
  };

  const applyTestFailureFeedback = ({
    kind,
    reason,
    fallbackKey,
  }: {
    kind: TestFailureKind;
    reason?: unknown;
    fallbackKey: string;
  }) => {
    void message.destroy("connection-test-failure");
    setTestResult({
      type: "error",
      kind,
      reason: String(reason ?? ""),
      fallbackKey,
    });
  };

  const handleTest = async (hostKeyFingerprintOverride = "") => {
    if (testInFlightRef.current) return;
    testInFlightRef.current = true;
    const testRunId = ++testRunIdRef.current;
    const isCurrentTestRun = () => testRunIdRef.current === testRunId;
    let sshProgressRunId = "";
    let nacosTestRunId = "";
    let cancellableRequest: {
      promise: Promise<any>;
      cancel: () => void;
    } | null = null;
    try {
      await form.validateFields();
      if (!isCurrentTestRun()) return;
      const values = { ...form.getFieldsValue(true), type: dbType };
      const unavailableReason = await resolveDriverUnavailableReason(
        values.type,
        values.driver,
      );
      if (!isCurrentTestRun()) return;
      if (unavailableReason) {
        applyTestFailureFeedback({
          kind: "driver_unavailable",
          reason: unavailableReason,
          fallbackKey: "connection.modal.test.fallback.driverUnavailable",
        });
        promptInstallDriver(
          resolveConnectionDriverType(values.type, values.driver) || values.type,
          unavailableReason,
        );
        return;
      }
      const blockingSecretClearMessage = getBlockingSecretClearMessage({
        values,
        clearSecrets,
        initialValues,
        translate: t,
      });
      if (blockingSecretClearMessage) {
        applyTestFailureFeedback({
          kind: "secret_blocked",
          reason: blockingSecretClearMessage,
          fallbackKey: "connection.modal.test.fallback.incompleteParams",
        });
        return;
      }
      setTestingConnection(true);
      setTestResult(null);
      const config = await buildConnectionConfig({
        values,
        forPersist: false,
        initialValues,
        nacosNamespaceIdTouched:
          form.isFieldTouched?.("nacosNamespaceId") === true,
        oracleModeTouched: oracleModeTouchedRef.current,
        translate: t,
      });
      if (!isCurrentTestRun()) return;
      if (hostKeyFingerprintOverride && (config as any).ssh) {
        (config as any).ssh = {
          ...(config as any).ssh,
          hostKeyFingerprint: hostKeyFingerprintOverride,
        };
      }
      if (initialValues?.id) {
        config.id = initialValues.id;
      }
      const timeoutSecondsRaw = Number(values.timeout);
      const timeoutSeconds =
        Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
          ? Math.min(timeoutSecondsRaw, MAX_TIMEOUT_SECONDS)
          : 30;
      const rpcTimeoutMs = (timeoutSeconds + 5) * 1000;

      // Use different API for Redis / JVM / Nacos
      const isRedisType = values.type === "redis";
      const isJVMType = values.type === "jvm";
      const isNacosType = values.type === "nacos";
      const dbTestConfig =
        !isRedisType && !isJVMType && !isNacosType
          ? buildRpcConnectionConfig(config as any)
          : config;
      const shouldReportSSHProgress =
        Boolean((config as any).useSSH) &&
        !isRedisType &&
        !isJVMType;
      if (shouldReportSSHProgress) {
        const sshConfig = (dbTestConfig as any)?.ssh || (config as any)?.ssh || {};
        sshProgressRunId = `ssh-test-${testRunId}-${Date.now()}`;
        setSSHConnectionProgress(
          createSSHConnectionProgress({
            runId: sshProgressRunId,
            host: String(sshConfig.host || ""),
            port: Number(sshConfig.port) || 22,
          }),
        );
        setSSHProgressPanelOpen(true);
      }
      if (isNacosType) {
        nacosTestRunId =
          sshProgressRunId || `nacos-test-${testRunId}-${Date.now()}`;
        activeNacosTestRunIdRef.current = nacosTestRunId;
      }
      const rpcPromise = isJVMType
        ? TestJVMConnection(config as any)
        : isRedisType
          ? RedisConnect(config as any)
          : isNacosType
            ? NacosTestConnectionWithProgress(config as any, nacosTestRunId)
            : shouldReportSSHProgress
              ? TestConnectionWithProgress(dbTestConfig as any, sshProgressRunId)
              : TestConnection(dbTestConfig as any);
      cancellableRequest = makeCancellableConnectionTestRequest(rpcPromise);
      const res = await withClientTimeout(
        cancellableRequest.promise,
        rpcTimeoutMs,
        t("connection.modal.test.timeout", { seconds: timeoutSeconds }),
      );

      if (!isCurrentTestRun()) return;

      const hostKeyTrust = Boolean((config as any).useSSH)
        ? readSSHHostKeyTrustDetails(res?.data)
        : null;
      if (hostKeyTrust) {
        if (sshProgressRunId) {
          setSSHConnectionProgress((current) =>
            current?.runId === sshProgressRunId
              ? finishSSHConnectionProgress(current, {
                  success: false,
                  reason: normalizeConnectionSecretErrorMessage(
                    res?.message,
                    t("connection.modal.error.unknown"),
                  ),
                })
              : current,
          );
          setSSHProgressPanelOpen(false);
        }
        setSSHHostKeyTrust(hostKeyTrust);
        setTestResult(null);
        return;
      }

      if (res.success) {
        if (sshProgressRunId) {
          setSSHConnectionProgress((current) =>
            current?.runId === sshProgressRunId
              ? finishSSHConnectionProgress(current, { success: true })
              : current,
          );
        }
        void message.destroy("connection-test-failure");
        setTestResult({ type: "success", message: res.message });
        void (async () => {
          try {
            if (isRedisType) {
              const dbRes = await withClientTimeout(
                RedisGetDatabases(config as any),
                rpcTimeoutMs,
                t("connection.modal.test.redis_database_list_timeout", {
                  seconds: timeoutSeconds,
                }),
              );
              if (!isCurrentTestRun()) return;
              if (dbRes.success) {
                const supportedDbs = extractRedisDatabaseList(dbRes.data);
                setRedisDbList(supportedDbs);
                form.setFieldValue(
                  "includeRedisDatabases",
                  normalizeRedisDatabaseSelection(
                    form.getFieldValue("includeRedisDatabases"),
                    supportedDbs,
                  ),
                );
              } else {
                setRedisDbList(
                  buildRedisDatabaseList(
                    config.redisDB,
                    form.getFieldValue("includeRedisDatabases"),
                  ),
                );
                message.warning(
                  t("connection.modal.test.redis_database_list_failure", {
                    detail: normalizeConnectionSecretErrorMessage(
                      dbRes.message,
                      t("connection.modal.error.unknown"),
                    ),
                  }),
                );
              }
            } else if (!isJVMType && !isNacosType) {
              const dbRes = await withClientTimeout(
                DBGetDatabases(dbTestConfig as any),
                rpcTimeoutMs,
                t("connection.modal.test.databaseListTimeout", {
                  seconds: timeoutSeconds,
                }),
              );
              if (!isCurrentTestRun()) return;
              if (dbRes.success) {
                const dbRows = Array.isArray(dbRes.data) ? dbRes.data : [];
                const dbs = dbRows
                  .map((row: any) => row?.Database || row?.database)
                  .filter(
                    (name: any) =>
                      typeof name === "string" && name.trim() !== "",
                  );
                setDbList(dbs);
                if (dbs.length === 0) {
                  message.warning(
                    values.type === "dameng"
                      ? t("connection.modal.test.noVisibleSchema")
                      : t("connection.modal.test.noVisibleDatabaseList"),
                  );
                }
              } else {
                setDbList([]);
                message.warning(
                  t("connection.modal.test.databaseListFailure", {
                    detail: normalizeConnectionSecretErrorMessage(
                      dbRes.message,
                      t("connection.modal.error.unknown"),
                    ),
                  }),
                );
              }
            }
          } catch (error: unknown) {
            if (!isCurrentTestRun()) return;
            const detail = normalizeConnectionSecretErrorMessage(
              error instanceof Error ? error.message : String(error),
              t("connection.modal.error.unknown"),
            );
            message.warning(
              isRedisType
                ? t("connection.modal.test.redis_database_list_failure", {
                    detail,
                  })
                : t("connection.modal.test.databaseListFailure", { detail }),
            );
          }
        })();
      } else {
        if (sshProgressRunId) {
          setSSHConnectionProgress((current) =>
            current?.runId === sshProgressRunId
              ? finishSSHConnectionProgress(current, {
                  success: false,
                  reason: normalizeConnectionSecretErrorMessage(
                    res?.message,
                    t("connection.modal.error.unknown"),
                  ),
                })
              : current,
          );
        }
        applyTestFailureFeedback({
          kind: "runtime",
          reason: res?.message,
          fallbackKey: "connection.modal.test.fallback.rejected",
        });
      }
    } catch (e: unknown) {
      if (!isCurrentTestRun()) return;
      if (e && typeof e === "object" && "errorFields" in e) {
        applyTestFailureFeedback({
          kind: "validation",
          fallbackKey: "connection.modal.test.fallback.validation",
        });
        return;
      }
      const reason =
        e instanceof Error
          ? e.message
          : typeof e === "string"
            ? e
            : t("connection.modal.test.fallback.unknownException");
      if (sshProgressRunId) {
        setSSHConnectionProgress((current) =>
          current?.runId === sshProgressRunId
            ? finishSSHConnectionProgress(current, {
                success: false,
                reason: normalizeConnectionSecretErrorMessage(
                  reason,
                  t("connection.modal.error.unknown"),
                ),
              })
            : current,
        );
      }
      applyTestFailureFeedback({
        kind: "runtime",
        reason,
        fallbackKey: "connection.modal.test.fallback.unknownException",
      });
    } finally {
      if (
        cancellableRequest &&
        activeTestCancellationRef.current === cancellableRequest.cancel
      ) {
        activeTestCancellationRef.current = null;
      }
      if (
        nacosTestRunId &&
        activeNacosTestRunIdRef.current === nacosTestRunId
      ) {
        activeNacosTestRunIdRef.current = "";
      }
      if (isCurrentTestRun()) {
        testInFlightRef.current = false;
        setTestingConnection(false);
      }
    }
  };
  return { handleOk, requestTest, handleTest };
};

export type ConnectionModalSaveAndTestApi = ReturnType<typeof useConnectionModalSaveAndTest>;
