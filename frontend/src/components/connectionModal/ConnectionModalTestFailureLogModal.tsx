import Modal from "../common/ResizableDraggableModal";
import { FileTextOutlined } from "@ant-design/icons";
import { t } from "../../i18n";
import { APP_NESTED_MODAL_Z_INDEX } from "../../utils/overlayZIndex";
import { Button } from "antd";
import type { ConnectionModalSectionRenderersApi } from "./useConnectionModalSectionRenderers";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";

export interface ConnectionModalTestFailureLogModalProps {
  renderConnectionModalTitle: ConnectionModalSectionRenderersApi['renderConnectionModalTitle'];
  testErrorLogOpen: ConnectionModalStateApi['testErrorLogOpen'];
  setTestErrorLogOpen: ConnectionModalStateApi['setTestErrorLogOpen'];
  modalShellStyle: ConnectionModalLifecycleApi['modalShellStyle'];
  resolvedTestResultMessage: ConnectionModalStateApi['resolvedTestResultMessage'];
}

export const ConnectionModalTestFailureLogModal = ({
  renderConnectionModalTitle,
  testErrorLogOpen,
  setTestErrorLogOpen,
  modalShellStyle,
  resolvedTestResultMessage,
}: ConnectionModalTestFailureLogModalProps) => (
  <Modal
    title={renderConnectionModalTitle(
      <FileTextOutlined />,
      t("connection.modal.failureDialog.title"),
      t("connection.modal.failureDialog.description"),
    )}
    open={testErrorLogOpen}
    onCancel={() => setTestErrorLogOpen(false)}
    centered
    width={760}
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
      <Button key="close" onClick={() => setTestErrorLogOpen(false)}>
        {t("common.action.close")}
      </Button>,
    ]}
  >
    <pre
      style={{
        margin: 0,
        maxHeight: "50vh",
        overflowY: "auto",
        padding: 12,
        borderRadius: 6,
        background: "#fff2f0",
        border: "1px solid #ffccc7",
        color: "#a8071a",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        lineHeight: "20px",
        fontSize: 13,
        fontFamily: "var(--gn-font-mono)",
      }}
    >
      {String(
        resolvedTestResultMessage ||
          t("connection.modal.failureDialog.emptyLog"),
      )}
    </pre>
  </Modal>
);
