import { parseUriToValues, buildUriFromValues, normalizeFileDbPath } from "./connectionModalUri";
import { getCustomConnectionDsnValidationMessage } from "../../utils/customConnectionDsn";
import { mergeParsedUriValuesForForm } from "../../utils/connectionUriMerge";
import {
  SelectSSHKeyFile,
  SelectCertificateFile,
  SelectDatabaseFile,
} from "../../../wailsjs/go/app/App";
import { isBackendCancelledResult } from "../../utils/connectionExport";
import { message } from "antd";
import { t } from "../../i18n";
import { normalizeConnectionSecretErrorMessage } from "../../utils/connectionModalPresentation";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalUriActionsInput {
  dbType: ConnectionModalStateApi['dbType'];
  initialValues: ConnectionModalProps['initialValues'];
  clearSecrets: ConnectionModalStateApi['clearSecrets'];
  form: ConnectionModalStateApi['form'];
  setUriFeedback: ConnectionModalStateApi['setUriFeedback'];
  testResult: ConnectionModalStateApi['testResult'];
  setTestResult: ConnectionModalStateApi['setTestResult'];
  selectingSSHKey: ConnectionModalStateApi['selectingSSHKey'];
  setSelectingSSHKey: ConnectionModalStateApi['setSelectingSSHKey'];
  selectingCertificateField: ConnectionModalStateApi['selectingCertificateField'];
  setSelectingCertificateField: ConnectionModalStateApi['setSelectingCertificateField'];
  selectingDbFile: ConnectionModalStateApi['selectingDbFile'];
  setSelectingDbFile: ConnectionModalStateApi['setSelectingDbFile'];
  primaryPasswordRevealRequestRef: ConnectionModalStateApi['primaryPasswordRevealRequestRef'];
  setPrimaryPasswordVisible: ConnectionModalStateApi['setPrimaryPasswordVisible'];
  setPrimaryPasswordVisibilityRevision: ConnectionModalStateApi['setPrimaryPasswordVisibilityRevision'];
  clearSecretsRef: ConnectionModalStateApi['clearSecretsRef'];
  revealedPrimaryPasswordRef: ConnectionModalStateApi['revealedPrimaryPasswordRef'];
}

export const useConnectionModalUriActions = ({
  dbType,
  initialValues,
  clearSecrets,
  form,
  setUriFeedback,
  testResult,
  setTestResult,
  selectingSSHKey,
  setSelectingSSHKey,
  selectingCertificateField,
  setSelectingCertificateField,
  selectingDbFile,
  setSelectingDbFile,
  primaryPasswordRevealRequestRef,
  setPrimaryPasswordVisible,
  setPrimaryPasswordVisibilityRevision,
  clearSecretsRef,
  revealedPrimaryPasswordRef,
}: UseConnectionModalUriActionsInput) => {
  const createUriAwareRequiredRule =
    (messageText: string, validateValue?: (value: unknown) => boolean) =>
    ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
      validator(_: unknown, value: unknown) {
        const uriText = String(getFieldValue("uri") || "").trim();
        const type = String(getFieldValue("type") || dbType)
          .trim()
          .toLowerCase();
        if (uriText && parseUriToValues(uriText, type)) {
          return Promise.resolve();
        }
        const valid = validateValue
          ? validateValue(value)
          : String(value ?? "").trim() !== "";
        return valid
          ? Promise.resolve()
          : Promise.reject(new Error(messageText));
      },
    });

  const createCustomDsnRule = () => ({
    validator(_: unknown, value: unknown) {
      const validationMessage = getCustomConnectionDsnValidationMessage({
        dsnInput: value,
        hasStoredSecret: initialValues?.hasOpaqueDSN,
        clearStoredSecret: clearSecrets.opaqueDSN,
      });
      return validationMessage
        ? Promise.reject(new Error(validationMessage))
        : Promise.resolve();
    },
  });

  const handleGenerateURI = () => {
    try {
      const values = form.getFieldsValue(true);
      const uri = buildUriFromValues(values);
      form.setFieldValue("uri", uri);
      setUriFeedback({
        type: "success",
        messageKey: "connection.modal.uri.feedback.generated",
      });
    } catch {
      setUriFeedback({
        type: "error",
        messageKey: "connection.modal.uri.feedback.generateFailed",
      });
    }
  };

  const handleParseURI = () => {
    try {
      const uriText = String(form.getFieldValue("uri") || "").trim();
      const type = String(form.getFieldValue("type") || dbType)
        .trim()
        .toLowerCase();
      if (!uriText) {
        setUriFeedback({
          type: "warning",
          messageKey: "connection.modal.uri.feedback.emptyInput",
        });
        return;
      }
      const parsedValues = parseUriToValues(uriText, type);
      if (!parsedValues) {
        setUriFeedback({
          type: "error",
          messageKey: "connection.modal.uri.feedback.unsupported",
        });
        return;
      }
      form.setFieldsValue(
        mergeParsedUriValuesForForm(
          form.getFieldsValue(true),
          parsedValues,
          uriText,
        ),
      );
      if (testResult) {
        setTestResult(null);
      }
      setUriFeedback({
        type: "success",
        messageKey: "connection.modal.uri.feedback.parsed",
      });
    } catch {
      setUriFeedback({
        type: "error",
        messageKey: "connection.modal.uri.feedback.parseFailed",
      });
    }
  };

  const handleCopyURI = async () => {
    let uriText = String(form.getFieldValue("uri") || "").trim();
    if (!uriText) {
      const values = form.getFieldsValue(true);
      uriText = buildUriFromValues(values);
      form.setFieldValue("uri", uriText);
    }
    if (!uriText) {
      setUriFeedback({
        type: "warning",
        messageKey: "connection.modal.uri.feedback.emptyCopy",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(uriText);
      setUriFeedback({
        type: "success",
        messageKey: "connection.modal.uri.feedback.copied",
      });
    } catch {
      setUriFeedback({
        type: "error",
        messageKey: "connection.modal.uri.feedback.copyFailed",
      });
    }
  };

  const handleSelectSSHKeyFile = async () => {
    if (selectingSSHKey) {
      return;
    }
    try {
      setSelectingSSHKey(true);
      const currentPath = String(form.getFieldValue("sshKeyPath") || "").trim();
      const res = await SelectSSHKeyFile(currentPath);
      if (res?.success) {
        const data = res.data || {};
        const selectedPath =
          typeof data === "string" ? data : String(data.path || "").trim();
        if (selectedPath) {
          form.setFieldValue("sshKeyPath", selectedPath);
        }
      } else if (!isBackendCancelledResult(res)) {
        message.error(
          t("connection.modal.filePicker.sshKeyFailure", {
            detail: res?.message || t("connection.modal.error.unknown"),
          }),
        );
      }
    } catch (e: any) {
      message.error(
        t("connection.modal.filePicker.sshKeyFailure", {
          detail: e?.message || String(e),
        }),
      );
    } finally {
      setSelectingSSHKey(false);
    }
  };

  const handleSelectCertificateFile = async (
    fieldName: "sslCAPath" | "sslCertPath" | "sslKeyPath",
    certKind: "ca" | "client-cert" | "client-key",
  ) => {
    if (selectingCertificateField) {
      return;
    }
    try {
      setSelectingCertificateField(fieldName);
      const currentPath = String(form.getFieldValue(fieldName) || "").trim();
      const res = await SelectCertificateFile(currentPath, certKind);
      if (res?.success) {
        const data = res.data || {};
        const selectedPath =
          typeof data === "string" ? data : String(data.path || "").trim();
        if (selectedPath) {
          form.setFieldValue(fieldName, selectedPath);
        }
      } else if (!isBackendCancelledResult(res)) {
        message.error(
          t("connection.modal.filePicker.certificateFailure", {
            detail: res?.message || t("connection.modal.error.unknown"),
          }),
        );
      }
    } catch (e: any) {
      message.error(
        t("connection.modal.filePicker.certificateFailure", {
          detail: e?.message || String(e),
        }),
      );
    } finally {
      setSelectingCertificateField(null);
    }
  };

  const handleSelectDatabaseFile = async () => {
    if (selectingDbFile) {
      return;
    }
    try {
      setSelectingDbFile(true);
      const currentPath = String(form.getFieldValue("host") || "").trim();
      const res = await SelectDatabaseFile(currentPath, dbType);
      if (res?.success) {
        const data = res.data || {};
        const selectedPath =
          typeof data === "string" ? data : String(data.path || "").trim();
        if (selectedPath) {
          form.setFieldValue("host", normalizeFileDbPath(selectedPath));
        }
      } else if (!isBackendCancelledResult(res)) {
        message.error(
          t("connection.modal.filePicker.databaseFailure", {
            detail: res?.message || t("connection.modal.error.unknown"),
          }),
        );
      }
    } catch (e: any) {
      message.error(
        t("connection.modal.filePicker.databaseFailure", {
          detail: e?.message || String(e),
        }),
      );
    } finally {
      setSelectingDbFile(false);
    }
  };

  const handlePrimaryPasswordVisibleChange = async (nextVisible: boolean) => {
    const requestId = primaryPasswordRevealRequestRef.current + 1;
    primaryPasswordRevealRequestRef.current = requestId;
    if (!nextVisible) {
      setPrimaryPasswordVisible(false);
      return;
    }

    const currentPassword = String(form.getFieldValue("password") ?? "");
    if (currentPassword !== "" || !initialValues?.hasPrimaryPassword) {
      setPrimaryPasswordVisible(true);
      return;
    }

    setPrimaryPasswordVisible(false);
    setPrimaryPasswordVisibilityRevision((revision) => revision + 1);
    const connectionId = String(initialValues.id || "").trim();
    const backendApp = (window as any).go?.app?.App;
    if (
      connectionId === "" ||
      typeof backendApp?.RevealSavedConnectionPrimaryPassword !== "function"
    ) {
      setPrimaryPasswordVisible(false);
      setPrimaryPasswordVisibilityRevision((revision) => revision + 1);
      message.error(
        t("connection.modal.secret.reveal_failed", {
          detail: t("connection.modal.message.save_backend_unavailable"),
        }),
      );
      return;
    }

    const canApplyRevealResult = () =>
      primaryPasswordRevealRequestRef.current === requestId &&
      String(form.getFieldValue("password") ?? "") === "" &&
      !clearSecretsRef.current.primaryPassword;

    try {
      const password = await backendApp.RevealSavedConnectionPrimaryPassword(
        connectionId,
      );
      if (!canApplyRevealResult()) {
        return;
      }
      const revealedPassword = String(password ?? "");
      revealedPrimaryPasswordRef.current = revealedPassword;
      form.setFieldValue("password", revealedPassword);
      setPrimaryPasswordVisible(true);
    } catch (error: any) {
      if (!canApplyRevealResult()) {
        return;
      }
      setPrimaryPasswordVisible(false);
      setPrimaryPasswordVisibilityRevision((revision) => revision + 1);
      message.error(
        t("connection.modal.secret.reveal_failed", {
          detail: normalizeConnectionSecretErrorMessage(
            error?.message || error,
            t("connection.modal.error.unknown"),
          ),
        }),
      );
    }
  };
  return {
    createUriAwareRequiredRule,
    createCustomDsnRule,
    handleGenerateURI,
    handleParseURI,
    handleCopyURI,
    handleSelectSSHKeyFile,
    handleSelectCertificateFile,
    handleSelectDatabaseFile,
    handlePrimaryPasswordVisibleChange,
  };
};

export type ConnectionModalUriActionsApi = ReturnType<typeof useConnectionModalUriActions>;
