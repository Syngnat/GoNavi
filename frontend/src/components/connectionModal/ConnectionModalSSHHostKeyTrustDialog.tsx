import { Alert } from "antd";
import { t } from "../../i18n";
import type { ConnectionModalStateApi } from "./useConnectionModalState";

export interface ConnectionModalSSHHostKeyTrustDialogProps {
  sshHostKeyTrust: NonNullable<ConnectionModalStateApi['sshHostKeyTrust']>;
}

export const ConnectionModalSSHHostKeyTrustDialog = ({ sshHostKeyTrust }: ConnectionModalSSHHostKeyTrustDialogProps) => (
  <div className="gn-ssh-host-key-trust-dialog">
    <Alert
      type={sshHostKeyTrust.state === "changed" ? "warning" : "info"}
      showIcon
      message={t(
        sshHostKeyTrust.state === "changed"
          ? "connection.modal.network.ssh.hostKeyDialog.changedMessage"
          : "connection.modal.network.ssh.hostKeyDialog.unknownMessage",
      )}
    />
    <dl className="gn-ssh-host-key-trust-facts">
      <dt>{t("connection.modal.network.ssh.hostKeyDialog.host")}</dt>
      <dd>{sshHostKeyTrust.address}</dd>
      <dt>{t("connection.modal.network.ssh.hostKeyDialog.keyType")}</dt>
      <dd>{sshHostKeyTrust.keyType}</dd>
      <dt>
        {t("connection.modal.network.ssh.hostKeyDialog.fingerprint")}
      </dt>
      <dd>{sshHostKeyTrust.fingerprint}</dd>
      {sshHostKeyTrust.previousFingerprint ? (
        <>
          <dt>
            {t(
              "connection.modal.network.ssh.hostKeyDialog.previousFingerprint",
            )}
          </dt>
          <dd>{sshHostKeyTrust.previousFingerprint}</dd>
        </>
      ) : null}
    </dl>
    <div className="gn-ssh-host-key-trust-explanation">
      {t("connection.modal.network.ssh.hostKeyDialog.saveExplanation")}
    </div>
  </div>
);
