import Modal from "../common/ResizableDraggableModal";
import { FileTextOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import { t } from "../../i18n";
import { APP_NESTED_MODAL_Z_INDEX } from "../../utils/overlayZIndex";
import { Button, Space, Tabs, Tag } from "antd";
import type { ConnectionModalSectionRenderersApi } from "./useConnectionModalSectionRenderers";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";
import type { ConnectionTestLogLine } from "./useConnectionTestLog";
import { useConnectionTestFailureLogView } from "./useConnectionTestFailureLogView";
import { ConnectionTestFailureLogBody } from "./ConnectionTestFailureLogBody";

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
  const {
    snapshot, logError, logLines, keyword, keywordMatched,
    activeTab: resolvedTab, setActiveTab, logState,
  } = useConnectionTestFailureLogView({ resolvedTestResultMessage, testLog });

  const logBody = (
    <ConnectionTestFailureLogBody
      state={logState}
      lines={logLines}
      error={logError}
      truncated={snapshot?.truncated}
      path={snapshot?.path}
    />
  );

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
        activeKey={resolvedTab}
        onChange={setActiveTab}
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
                {keywordMatched && <Tag color="default">{keyword}</Tag>}
              </Space>
            ),
            children: logBody,
          },
        ]}
      />
    </Modal>
  );
};
