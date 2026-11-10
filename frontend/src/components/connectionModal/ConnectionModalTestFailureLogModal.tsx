import Modal from "../common/ResizableDraggableModal";
import { FileTextOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import { t } from "../../i18n";
import { APP_NESTED_MODAL_Z_INDEX } from "../../utils/overlayZIndex";
import { Button, Space, Spin, Tabs, Tag } from "antd";
import type { ConnectionModalSectionRenderersApi } from "./useConnectionModalSectionRenderers";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";
import {
  pickConnectionTestLogKeyword,
  type ConnectionTestLogLine,
} from "./useConnectionTestLog";

export interface ConnectionModalTestFailureLogModalProps {
  renderConnectionModalTitle: ConnectionModalSectionRenderersApi['renderConnectionModalTitle'];
  testErrorLogOpen: ConnectionModalStateApi['testErrorLogOpen'];
  setTestErrorLogOpen: ConnectionModalStateApi['setTestErrorLogOpen'];
  modalShellStyle: ConnectionModalLifecycleApi['modalShellStyle'];
  resolvedTestResultMessage: ConnectionModalStateApi['resolvedTestResultMessage'];
  testLog?: {
    snapshot: { path: string; lines: ConnectionTestLogLine[]; truncated: boolean } | null;
    loading: boolean;
    error: string;
    reload: () => void;
    openLogDirectory: () => void;
  };
}

const LEVEL_COLORS: Record<ConnectionTestLogLine['level'], string> = {
  ERROR: "#a8071a",
  WARN: "#ad6800",
  INFO: "#237804",
  OTHER: "#595959",
};

const codeBlockStyle: React.CSSProperties = {
  margin: 0,
  maxHeight: "52vh",
  overflowY: "auto",
  padding: 12,
  borderRadius: 6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  lineHeight: "20px",
  fontSize: 13,
  fontFamily: "var(--gn-font-mono)",
};

export const ConnectionModalTestFailureLogModal = ({
  renderConnectionModalTitle,
  testErrorLogOpen,
  setTestErrorLogOpen,
  modalShellStyle,
  resolvedTestResultMessage,
  testLog,
}: ConnectionModalTestFailureLogModalProps) => {
  const snapshot = testLog?.snapshot || null;
  const logError = String(testLog?.error || "").trim();
  const keyword = pickConnectionTestLogKeyword(String(resolvedTestResultMessage || ""));
  const logLines = snapshot?.lines || [];

  let logBody: React.ReactNode;
  if (testLog?.loading && !snapshot) {
    logBody = (
      <div style={{ padding: 24, textAlign: "center" }}>
        <Spin size="small" />
      </div>
    );
  } else if (logError) {
    logBody = (
      <pre style={{ ...codeBlockStyle, background: "#fff2f0", border: "1px solid #ffccc7", color: "#a8071a" }}>
        {t("connection.modal.failureDialog.logUnavailable", { detail: logError })}
      </pre>
    );
  } else if (logLines.length === 0) {
    logBody = (
      <pre style={{ ...codeBlockStyle, background: "#fafafa", border: "1px solid #f0f0f0", color: "#595959" }}>
        {t("connection.modal.failureDialog.logEmpty")}
      </pre>
    );
  } else {
    logBody = (
      <div>
        <pre style={{ ...codeBlockStyle, background: "#fafafa", border: "1px solid #f0f0f0" }}>
          {logLines.map((line, index) => (
            <div key={`${index}-${line.level}`} style={{ color: LEVEL_COLORS[line.level] }}>
              {line.text}
            </div>
          ))}
        </pre>
        {snapshot?.truncated && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#8c8c8c" }}>
            {t("connection.modal.failureDialog.logTruncated", { count: logLines.length })}
          </div>
        )}
        {snapshot?.path && (
          <div style={{ marginTop: 4, fontSize: 12, color: "#8c8c8c", wordBreak: "break-all" }}>
            {t("connection.modal.failureDialog.logPath", { path: snapshot.path })}
          </div>
        )}
      </div>
    );
  }

  return (
    <Modal
      title={renderConnectionModalTitle(
        <FileTextOutlined />,
        t("connection.modal.failureDialog.title"),
        t("connection.modal.failureDialog.description"),
      )}
      open={testErrorLogOpen}
      onCancel={() => setTestErrorLogOpen(false)}
      centered
      width={860}
      zIndex={APP_NESTED_MODAL_Z_INDEX}
      destroyOnHidden
      styles={{
        content: modalShellStyle,
        header: {
          background: "transparent",
          borderBottom: "none",
          paddingBottom: 8,
        },
        body: { paddingTop: 8 },
        footer: {
          background: "transparent",
          borderTop: "none",
          paddingTop: 10,
        },
      }}
      footer={[
        <Button
          key="open-log-dir"
          icon={<FolderOpenOutlined />}
          onClick={() => testLog?.openLogDirectory?.()}
          disabled={!testLog}
        >
          {t("connection.modal.failureDialog.openLogDir")}
        </Button>,
        <Button
          key="reload"
          icon={<ReloadOutlined />}
          onClick={() => testLog?.reload?.()}
          loading={Boolean(testLog?.loading)}
          disabled={!testLog}
        >
          {t("connection.modal.failureDialog.refresh")}
        </Button>,
        <Button key="close" type="primary" onClick={() => setTestErrorLogOpen(false)}>
          {t("common.action.close")}
        </Button>,
      ]}
    >
      <Tabs
        size="small"
        items={[
          {
            key: "error",
            label: t("connection.modal.failureDialog.errorTab"),
            children: (
              <pre
                style={{
                  ...codeBlockStyle,
                  background: "#fff2f0",
                  border: "1px solid #ffccc7",
                  color: "#a8071a",
                }}
              >
                {String(
                  resolvedTestResultMessage ||
                    t("connection.modal.failureDialog.emptyLog"),
                )}
              </pre>
            ),
          },
          {
            key: "log",
            label: (
              <Space size={6}>
                {t("connection.modal.failureDialog.logTab")}
                {keyword && <Tag color="default">{keyword}</Tag>}
              </Space>
            ),
            children: logBody,
          },
        ]}
      />
    </Modal>
  );
};
