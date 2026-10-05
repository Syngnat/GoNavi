import React from "react";
import { Alert, Button, Card, Descriptions, Empty, Input, Skeleton, Space, Tag } from "antd";
import {
  FileSearchOutlined,
  ReloadOutlined,
  } from "@ant-design/icons";
import Editor from "./MonacoEditor";
import AiSparkOutlined from "./icons/AiSparkOutlined";
import type { TabData } from "../types";
import {
  estimateJVMResourceEditorHeight, formatJVMActionDisplayText, formatJVMActionSummary,
  resolveJVMActionDisplay,
} from "../utils/jvmResourcePresentation";
import JVMModeBadge from "./jvm/JVMModeBadge";
import JVMChangePreviewModal from "./jvm/JVMChangePreviewModal";
import {
  getJVMWorkspaceCardStyle,
  JVMWorkspaceHero,
  JVMWorkspaceShell,
} from "./jvm/JVMWorkspaceLayout";
import {
  Text,
  DESCRIPTION_STYLES,
  snapshotBlockStyle,
  TextArea,
} from "./jvm/resourceBrowser/jvmResourceBrowserModel";
import { useJVMResourceBrowserState } from "./jvm/resourceBrowser/hooks/useJVMResourceBrowserState";
import {
  useJVMResourceBrowserActions,
} from "./jvm/resourceBrowser/hooks/useJVMResourceBrowserActions";

export type JVMResourceBrowserProps = {
  tab: TabData;
};

const JVMResourceBrowser: React.FC<JVMResourceBrowserProps> = ({ tab }) => {
  const {
    i18nLanguage, tr, connection, darkMode, providerMode, resourcePath, readOnly, loading, snapshot,
    setSnapshot, error, action, reason, setReason, payloadText, setPayloadText, draftSource,
    draftResourceId, draftError, setDraftError, applyMessage, setApplyMessage, previewLoading,
    setPreviewLoading, previewOpen, setPreviewOpen, previewResult, setPreviewResult, previewRequest,
    setPreviewRequest, previewRuntimeConfig, setPreviewRuntimeConfig, previewContextKey,
    setPreviewContextKey, applyLoading, setApplyLoading, previewSequenceRef,
    currentPreviewContextKey, previewContextKeyRef, clearPreviewState, displayValue,
    displayLanguage, metadataText, metadataLanguage, supportedActions, selectedActionDefinition,
    selectedActionDisplay, loadSnapshot, handleSelectAction, buildDraftPlan, handleOpenAudit,
    handleAskAIForPlan,
  } = useJVMResourceBrowserState({ tab });

  const { handlePreview, handleApply } = useJVMResourceBrowserActions({
    connection, setDraftError, tr, buildDraftPlan, previewSequenceRef, currentPreviewContextKey,
    providerMode, setPreviewLoading, setApplyMessage, previewContextKeyRef, clearPreviewState,
    setPreviewResult, setPreviewRequest, setPreviewRuntimeConfig, setPreviewContextKey,
    setPreviewOpen, previewResult, previewRequest, previewRuntimeConfig, previewContextKey,
    setApplyLoading, setSnapshot, loadSnapshot,
  });

  if (!connection) {
    return (
      <Empty description={tr("jvm_resource.error.connection_missing")} style={{ marginTop: 64 }} />
    );
  }

  const cardStyle = getJVMWorkspaceCardStyle(darkMode);

  return (
    <>
      <style>{`
        .jvm-resource-browser-scroll-shell {
          scrollbar-width: thin;
        }
        .jvm-resource-browser-scroll-shell::-webkit-scrollbar,
        .jvm-resource-browser-code-block::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        .jvm-resource-browser-scroll-shell::-webkit-scrollbar-thumb,
        .jvm-resource-browser-code-block::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.22);
          border-radius: 999px;
        }
        .jvm-resource-browser-scroll-shell::-webkit-scrollbar-track,
        .jvm-resource-browser-code-block::-webkit-scrollbar-track {
          background: transparent;
        }
        @media (max-width: 1120px) {
          .jvm-resource-workbench {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
      <JVMWorkspaceShell
        darkMode={darkMode}
        className="jvm-resource-browser-scroll-shell"
        data-jvm-resource-browser-scroll-shell="true"
      >
        <JVMWorkspaceHero
          darkMode={darkMode}
          eyebrow="JVM Resource"
          title={tr("jvm_resource.title")}
          description={
            <>
              <Text strong>{connection.name}</Text>
              <Text type="secondary"> · {resourcePath || "-"}</Text>
            </>
          }
          badges={
            <>
              <JVMModeBadge mode={providerMode} />
              <Tag color={readOnly ? "blue" : "red"}>
                {readOnly
                  ? tr("jvm_resource.badge.read_only")
                  : tr("jvm_resource.badge.writable")}
              </Tag>
            </>
          }
          actions={
            <>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void loadSnapshot()}
              >
                {tr("common.refresh")}
              </Button>
              <Button
                size="small"
                icon={<FileSearchOutlined />}
                onClick={handleOpenAudit}
              >
                {tr("jvm_resource.action.audit")}
              </Button>
              <Button
                size="small"
                icon={<AiSparkOutlined />}
                onClick={handleAskAIForPlan}
              >
                {tr("jvm_resource.action.generate_ai_plan")}
              </Button>
            </>
          }
        />

        <div
          className="jvm-resource-workbench"
          data-jvm-resource-workbench="true"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 440px)",
            gap: 18,
            alignItems: "start",
          }}
        >
          <Card
            title={tr("jvm_resource.card.snapshot")}
            variant="borderless"
            style={{
              ...cardStyle,
              gridColumn: readOnly ? "1 / -1" : undefined,
            }}
          >
            {loading ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                {error ? <Alert type="error" showIcon message={error} /> : null}
                {snapshot ? (
                  <>
                    <Descriptions
                      column={1}
                      size="small"
                      styles={DESCRIPTION_STYLES}
                    >
                      <Descriptions.Item label={tr("jvm_resource.field.resource_id")}>
                        {snapshot.resourceId || "-"}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr("jvm_resource.field.resource_type")}>
                        {snapshot.kind || tab.resourceKind || "-"}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr("jvm_resource.field.format")}>
                        {snapshot.format || "-"}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr("jvm_resource.field.version")}>
                        {snapshot.version || "-"}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr("jvm_resource.field.available_actions")}>
                        {formatJVMActionSummary(supportedActions, i18nLanguage)}
                      </Descriptions.Item>
                    </Descriptions>
                    {snapshot.description ? (
                      <Text type="secondary">{snapshot.description}</Text>
                    ) : null}
                    <div>
                      <Text
                        strong
                        style={{ display: "block", marginBottom: 8 }}
                      >
                        {tr("jvm_resource.section.resource_value")}
                      </Text>
                      <div
                        className="jvm-resource-browser-code-block"
                        style={{
                          ...snapshotBlockStyle("rgba(0, 0, 0, 0.04)"),
                          height: estimateJVMResourceEditorHeight(displayValue),
                        }}
                      >
                        <Editor
                          height="100%"
                          language={displayLanguage}
                          theme={
                            darkMode ? "transparent-dark" : "transparent-light"
                          }
                          value={displayValue}
                          options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            lineNumbers: "on",
                            wordWrap: "on",
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            folding: true,
                            renderValidationDecorations: "off",
                          }}
                        />
                      </div>
                    </div>
                    {metadataText ? (
                      <div>
                        <Text
                          strong
                          style={{ display: "block", marginBottom: 8 }}
                        >
                          {tr("jvm_resource.section.metadata")}
                        </Text>
                        <div
                          className="jvm-resource-browser-code-block"
                          style={{
                            ...snapshotBlockStyle("rgba(0, 0, 0, 0.03)"),
                            height:
                              estimateJVMResourceEditorHeight(metadataText),
                          }}
                        >
                          <Editor
                            height="100%"
                            language={metadataLanguage}
                            theme={
                              darkMode
                                ? "transparent-dark"
                                : "transparent-light"
                            }
                            value={metadataText}
                            options={{
                              readOnly: true,
                              minimap: { enabled: false },
                              lineNumbers: "on",
                              wordWrap: "on",
                              scrollBeyondLastLine: false,
                              automaticLayout: true,
                              folding: true,
                              renderValidationDecorations: "off",
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : error ? null : (
                  <Empty description={tr("jvm_resource.empty.no_resource_data")} />
                )}
              </Space>
            )}
          </Card>

          {!readOnly ? (
            <Card title={tr("jvm_resource.card.change_draft")} variant="borderless" style={cardStyle}>
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                {draftError ? (
                  <Alert type="error" showIcon message={draftError} />
                ) : null}
                {applyMessage ? (
                  <Alert type="success" showIcon message={applyMessage} />
                ) : null}
                <Descriptions
                  column={1}
                  size="small"
                  styles={DESCRIPTION_STYLES}
                >
                  <Descriptions.Item label={tr("jvm_resource.field.resource_path")}>
                    {resourcePath || "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr("jvm_resource.field.target_resource")}>
                    {draftResourceId || resourcePath || "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr("jvm_resource.field.resource_version")}>
                    {snapshot?.version || "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr("jvm_resource.field.draft_source")}>
                    {draftSource === "ai-plan"
                      ? tr("jvm_resource.draft_source.ai_plan")
                      : tr("jvm_resource.draft_source.manual")}
                  </Descriptions.Item>
                </Descriptions>
                {supportedActions.length > 0 ? (
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
                    <Text strong>
                      {tr("jvm_resource.section.supported_actions")}
                    </Text>
                    <Space size={8} wrap>
                      {supportedActions.map((item) => (
                        <Button
                          key={item.action}
                          size="small"
                          type={action === item.action ? "primary" : "default"}
                          danger={item.dangerous}
                          onClick={() => handleSelectAction(item.action, item)}
                        >
                          {resolveJVMActionDisplay(item, i18nLanguage).label}
                        </Button>
                      ))}
                    </Space>
                    {selectedActionDisplay.description ? (
                      <Text type="secondary">
                        {selectedActionDisplay.description}
                      </Text>
                    ) : null}
                    {selectedActionDefinition?.payloadFields?.length ? (
                      <Text type="secondary">
                        {tr("jvm_resource.field.payload_fields")}
                        {selectedActionDefinition.payloadFields
                          .map(
                            (field) =>
                              `${field.name}${
                                field.required
                                  ? tr("jvm_resource.marker.required_suffix")
                                  : ""
                              }`,
                          )
                          .join(tr("jvm_resource.list_separator"))}
                      </Text>
                    ) : null}
                  </Space>
                ) : null}
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Text strong>{tr("jvm_resource.field.action")}</Text>
                  <Input
                    value={action}
                    onChange={(event) =>
                      handleSelectAction(
                        event.target.value,
                        selectedActionDefinition,
                      )
                    }
                    placeholder={
                      providerMode === "jmx"
                        ? tr("jvm_resource.placeholder.action_jmx")
                        : tr("jvm_resource.placeholder.action_default")
                    }
                    maxLength={64}
                  />
                  {action ? (
                    <Text type="secondary">
                      {tr("jvm_resource.message.current_action")}
                      {formatJVMActionDisplayText(
                        selectedActionDisplay,
                        i18nLanguage,
                      )}
                    </Text>
                  ) : null}
                </Space>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Text strong>{tr("jvm_resource.field.reason")}</Text>
                  <Input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={tr("jvm_resource.placeholder.reason")}
                    maxLength={200}
                  />
                </Space>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Text strong>{tr("jvm_resource.field.payload")}</Text>
                  <Text type="secondary">
                    {tr("jvm_resource.message.payload_hint")}
                    {selectedActionDefinition?.payloadExample &&
                    !snapshot?.sensitive
                      ? ` ${tr("jvm_resource.message.payload_template_applied")}`
                      : ""}
                  </Text>
                  <TextArea
                    value={payloadText}
                    onChange={(event) => setPayloadText(event.target.value)}
                    autoSize={{ minRows: 8, maxRows: 18 }}
                    spellCheck={false}
                  />
                </Space>
                <Space size={12} wrap>
                  <Button
                    type="primary"
                    loading={previewLoading}
                    onClick={() => void handlePreview()}
                  >
                    {tr("jvm_resource.action.preview_change")}
                  </Button>
                  <Button icon={<AiSparkOutlined />} onClick={handleAskAIForPlan}>
                    {tr("jvm_resource.action.ask_ai_plan")}
                  </Button>
                </Space>
              </Space>
            </Card>
          ) : null}
        </div>
      </JVMWorkspaceShell>

      <JVMChangePreviewModal
        open={previewOpen}
        preview={previewResult}
        applying={applyLoading}
        onCancel={() => {
          if (applyLoading) {
            return;
          }
          setPreviewOpen(false);
        }}
        onConfirm={() => void handleApply()}
      />
    </>
  );
};

export default JVMResourceBrowser;
