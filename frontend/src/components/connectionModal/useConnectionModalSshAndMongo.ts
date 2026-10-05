import { buildConnectionConfig, getBlockingSecretClearMessage } from "./connectionModalConfig";
import { t } from "../../i18n";
import { TrustSSHHostKeyForConnection, MongoDiscoverMembers } from "../../../wailsjs/go/app/App";
import { buildRpcConnectionConfig } from "../../utils/connectionRpcConfig";
import { normalizeConnectionSecretErrorMessage } from "../../utils/connectionModalPresentation";
import { message } from "antd";
import { MongoMemberInfo } from "../../types";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalSaveAndTestApi } from "./useConnectionModalSaveAndTest";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalSshAndMongoInput {
  sshHostKeyTrust: ConnectionModalStateApi['sshHostKeyTrust'];
  setSSHHostKeyTrust: ConnectionModalStateApi['setSSHHostKeyTrust'];
  trustingSSHHostKey: ConnectionModalStateApi['trustingSSHHostKey'];
  handleTest: ConnectionModalSaveAndTestApi['handleTest'];
  initialValues: ConnectionModalProps['initialValues'];
  setTrustingSSHHostKey: ConnectionModalStateApi['setTrustingSSHHostKey'];
  form: ConnectionModalStateApi['form'];
  dbType: ConnectionModalStateApi['dbType'];
  oracleModeTouchedRef: ConnectionModalStateApi['oracleModeTouchedRef'];
  discoveringMembers: ConnectionModalStateApi['discoveringMembers'];
  setDiscoveringMembers: ConnectionModalStateApi['setDiscoveringMembers'];
  clearSecrets: ConnectionModalStateApi['clearSecrets'];
  setMongoMembers: ConnectionModalStateApi['setMongoMembers'];
}

export const useConnectionModalSshAndMongo = ({
  sshHostKeyTrust,
  setSSHHostKeyTrust,
  trustingSSHHostKey,
  handleTest,
  initialValues,
  setTrustingSSHHostKey,
  form,
  dbType,
  oracleModeTouchedRef,
  discoveringMembers,
  setDiscoveringMembers,
  clearSecrets,
  setMongoMembers,
}: UseConnectionModalSshAndMongoInput) => {
  const handleContinueSSHHostKeyOnce = () => {
    const trust = sshHostKeyTrust;
    if (!trust || trustingSSHHostKey) return;
    setSSHHostKeyTrust(null);
    void handleTest(trust.fingerprint);
  };

  const handleTrustAndSaveSSHHostKey = async () => {
    const trust = sshHostKeyTrust;
    if (!trust || trustingSSHHostKey) return;
    setTrustingSSHHostKey(true);
    try {
      const values = { ...form.getFieldsValue(true), type: dbType };
      const config = await buildConnectionConfig({
        values,
        forPersist: false,
        initialValues,
        nacosNamespaceIdTouched:
          form.isFieldTouched?.("nacosNamespaceId") === true,
        oracleModeTouched: oracleModeTouchedRef.current,
        translate: t,
      });
      if (initialValues?.id) {
        config.id = initialValues.id;
      }
      const result = await TrustSSHHostKeyForConnection(
        buildRpcConnectionConfig(config as any),
        trust.fingerprint,
      );
      if (!result?.success) {
        throw new Error(
          result?.message ||
            t("connection.modal.network.ssh.hostKeyDialog.saveFailure", {
              detail: t("connection.modal.error.unknown"),
            }),
        );
      }
      // Migrate an old manual pin only after its replacement was safely saved
      // in GoNavi's managed trust store. The transient \"continue once\" path
      // deliberately leaves the saved connection unchanged.
      form.setFieldValue("sshHostKeyFingerprint", "");
      setSSHHostKeyTrust(null);
      void handleTest();
    } catch (error: unknown) {
      const detail = normalizeConnectionSecretErrorMessage(
        error instanceof Error ? error.message : String(error),
        t("connection.modal.error.unknown"),
      );
      message.error(
        t("connection.modal.network.ssh.hostKeyDialog.saveFailure", { detail }),
      );
    } finally {
      setTrustingSSHHostKey(false);
    }
  };

  const handleDiscoverMongoMembers = async () => {
    if (discoveringMembers || dbType !== "mongodb") {
      return;
    }
    try {
      await form.validateFields();
      const values = form.getFieldsValue(true);
      setDiscoveringMembers(true);
      const blockingSecretClearMessage = getBlockingSecretClearMessage({
        values,
        clearSecrets,
        initialValues,
        translate: t,
      });
      if (blockingSecretClearMessage) {
        message.error(blockingSecretClearMessage);
        return;
      }
      const config = await buildConnectionConfig({
        values,
        forPersist: false,
        initialValues,
        oracleModeTouched: oracleModeTouchedRef.current,
        translate: t,
      });
      if (initialValues?.id) {
        config.id = initialValues.id;
      }
      const result = await MongoDiscoverMembers(config as any);
      if (!result.success) {
        message.error(
          normalizeConnectionSecretErrorMessage(
            result.message,
            t("connection.modal.mongo.discover.failure"),
          ),
        );
        return;
      }
      const data = (result.data as Record<string, any>) || {};
      const membersRaw = Array.isArray(data.members) ? data.members : [];
      const members: MongoMemberInfo[] = membersRaw
        .map((item: any) => ({
          host: String(item.host || "").trim(),
          role: String(item.role || item.state || "").trim(),
          state: String(item.state || item.role || "").trim(),
          stateCode: Number(item.stateCode || 0),
          healthy: !!item.healthy,
          isSelf: !!item.isSelf,
        }))
        .filter((item: MongoMemberInfo) => !!item.host);
      setMongoMembers(members);
      if (!form.getFieldValue("mongoReplicaSet") && data.replicaSet) {
        form.setFieldValue("mongoReplicaSet", String(data.replicaSet));
      }
      message.success(
        result.message ||
          t(
            members.length === 1
              ? "connection.modal.mongo.discover.successOne"
              : "connection.modal.mongo.discover.successMany",
            { count: members.length },
          ),
      );
    } catch (error: any) {
      message.error(
        normalizeConnectionSecretErrorMessage(
          error?.message || error,
          t("connection.modal.mongo.discover.failure"),
        ),
      );
    } finally {
      setDiscoveringMembers(false);
    }
  };
  return {
    handleContinueSSHHostKeyOnce,
    handleTrustAndSaveSSHHostKey,
    handleDiscoverMongoMembers,
  };
};

export type ConnectionModalSshAndMongoApi = ReturnType<typeof useConnectionModalSshAndMongo>;
