import React, { useEffect, useState } from "react";
import { Button } from "antd";

import { t } from "../../i18n";
import type {
  SSHConnectionProgress,
  SSHConnectionProgressStatus,
  SSHConnectionProgressStepID,
} from "./sshConnectionProgress";

const stepTextKeys: Record<SSHConnectionProgressStepID, string> = {
  transport: "connection.modal.sshProgress.step.transport",
  "host-key": "connection.modal.sshProgress.step.hostKey",
  authentication: "connection.modal.sshProgress.step.authentication",
  tunnel: "connection.modal.sshProgress.step.tunnel",
  database: "connection.modal.sshProgress.step.database",
};

const statusTextKeys: Record<SSHConnectionProgressStatus, string> = {
  pending: "connection.modal.sshProgress.status.pending",
  running: "connection.modal.sshProgress.status.running",
  success: "connection.modal.sshProgress.status.success",
  error: "connection.modal.sshProgress.status.error",
};

const resolveLogText = (stage: string): string => {
  const key = `connection.modal.sshProgress.log.${stage}`;
  const translated = t(key);
  return translated === key ? stage : translated;
};

const SSHConnectionProgressPanel: React.FC<{
  progress: SSHConnectionProgress;
  onClose: () => void;
  onCancelTest: () => void;
}> = ({ progress, onClose, onCancelTest }) => {
  const [logsExpanded, setLogsExpanded] = useState(true);
  const isRunning = progress.status === "running";

  useEffect(() => {
    setLogsExpanded(true);
  }, [progress.runId]);

  return (
    <section className="gn-ssh-progress" aria-live="polite">
      <header className="gn-ssh-progress-head">
        <div>
          <div className="gn-ssh-progress-eyebrow">
            {t("connection.modal.sshProgress.eyebrow")}
          </div>
          <h2>{t("connection.modal.sshProgress.title")}</h2>
          <p>
            {progress.host || t("connection.modal.sshProgress.unknownHost")}
            :{progress.port}
          </p>
        </div>
        <div className="gn-ssh-progress-actions">
          <Button type="text" onClick={() => setLogsExpanded((value) => !value)}>
            {logsExpanded
              ? t("connection.modal.sshProgress.hideLogs")
              : t("connection.modal.sshProgress.showLogs")}
          </Button>
          {isRunning ? (
            <Button danger onClick={onCancelTest}>
              {t("connection.modal.action.cancel_test")}
            </Button>
          ) : (
            <Button onClick={onClose}>{t("common.action.close")}</Button>
          )}
        </div>
      </header>

      <ol className="gn-ssh-progress-steps">
        {progress.steps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span className="gn-ssh-progress-dot" aria-hidden="true" />
            <span>{t(stepTextKeys[step.id])}</span>
            <small>{t(statusTextKeys[step.status])}</small>
          </li>
        ))}
      </ol>

      <p className="gn-ssh-progress-summary" data-status={progress.status}>
        {t(statusTextKeys[progress.status])}
      </p>

      {logsExpanded ? (
        <div className="gn-ssh-progress-log" role="log">
          {progress.logs.map((entry, index) => (
            <div key={`${entry.stage}-${entry.status}-${index}`} data-status={entry.status}>
              <span className="gn-ssh-progress-log-dot" aria-hidden="true" />
              <span className="gn-ssh-progress-log-message">
                {resolveLogText(entry.stage)}
                {entry.detail ? (
                  <small className="gn-ssh-progress-log-detail">{entry.detail}</small>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
};

export default SSHConnectionProgressPanel;
