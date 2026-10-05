import { GatewayOutlined, ClusterOutlined } from "@ant-design/icons";
import { t } from "../../i18n";
import { Form, Input, InputNumber, Typography, Checkbox, Select, Space, Tag, Button } from "antd";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { JVM_EDITABLE_MODES } from "../../utils/jvmConnectionConfig";
import { resolveJVMModeMeta } from "../../utils/jvmRuntimePresentation";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

const { Text } = Typography;

export interface ConnectionStep2JvmModeCardsProps {
  jvmSectionCardStyle: ConnectionModalStep2Props['jvmSectionCardStyle'];
  renderJvmSectionHeader: ConnectionModalStep2Props['renderJvmSectionHeader'];
  renderChoiceCards: ConnectionModalStep2Props['renderChoiceCards'];
  jvmEnvironment: ConnectionModalStep2Props['jvmEnvironment'];
  normalizedJvmAllowedModes: ConnectionModalStep2Props['normalizedJvmAllowedModes'];
  jvmPreferredMode: ConnectionModalStep2Props['jvmPreferredMode'];
  handleJvmModeCardSelect: ConnectionModalStep2Props['handleJvmModeCardSelect'];
  darkMode: ConnectionModalStep2Props['darkMode'];
  modalMutedTextStyle: ConnectionModalStep2Props['modalMutedTextStyle'];
  handleJvmModeToggle: ConnectionModalStep2Props['handleJvmModeToggle'];
}

export const ConnectionStep2JvmModeCards = ({
  jvmSectionCardStyle,
  renderJvmSectionHeader,
  renderChoiceCards,
  jvmEnvironment,
  normalizedJvmAllowedModes,
  jvmPreferredMode,
  handleJvmModeCardSelect,
  darkMode,
  modalMutedTextStyle,
  handleJvmModeToggle,
}: ConnectionStep2JvmModeCardsProps) => (
  <>
    <div style={jvmSectionCardStyle()}>
      {renderJvmSectionHeader(
        <GatewayOutlined />,
        t("connection.modal.jvm.target.title"),
        t("connection.modal.jvm.target.description"),
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 120px",
          gap: 16,
          alignItems: "start",
        }}
      >
        <Form.Item
          name="host"
          label={t("connection.modal.jvm.host.label")}
          rules={[
            {
              required: true,
              message: t("connection.modal.jvm.host.required"),
            },
          ]}
          style={{ marginBottom: 0 }}
        >
          <Input
            {...noAutoCapInputProps}
            placeholder={t("connection.modal.example", {
              value: "localhost",
            })}
          />
        </Form.Item>
        <Form.Item
          name="port"
          label={t("connection.modal.jvm.port.label")}
          rules={[
            {
              required: true,
              message: t("connection.modal.jvm.port.required"),
            },
          ]}
          style={{ marginBottom: 0 }}
        >
          <InputNumber style={{ width: "100%" }} min={1} max={65535} />
        </Form.Item>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 16,
          marginTop: 16,
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <Text strong>
            {t("connection.modal.jvm.environment.title")}
          </Text>
          {renderChoiceCards({
            fieldName: "jvmEnvironment",
            value: String(jvmEnvironment),
            minWidth: 120,
            options: [
              {
                value: "dev",
                label: t(
                  "connection.modal.jvm.environment.dev.label",
                ),
                description: t(
                  "connection.modal.jvm.environment.dev.description",
                ),
              },
              {
                value: "uat",
                label: t(
                  "connection.modal.jvm.environment.staging.label",
                ),
                description: t(
                  "connection.modal.jvm.environment.staging.description",
                ),
              },
              {
                value: "prod",
                label: t(
                  "connection.modal.jvm.environment.prod.label",
                ),
                description: t(
                  "connection.modal.jvm.environment.prod.description",
                ),
              },
            ],
          })}
        </div>
        <Form.Item
          name="timeout"
          label={t("connection.modal.network.timeout.label")}
          rules={[
            {
              type: "number",
              min: 1,
              max: 300,
              message: t("connection.modal.network.timeout.range"),
            },
          ]}
          style={{ marginBottom: 0 }}
        >
          <InputNumber
            style={{ width: "100%" }}
            min={1}
            max={300}
            placeholder={t("connection.modal.example", {
              value: "30",
            })}
          />
        </Form.Item>
        <Form.Item
          name="jvmReadOnly"
          label={t("connection.modal.jvm.securityPolicy.label")}
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Checkbox>{t("connection.modal.jvm.readonlyPreferred")}</Checkbox>
        </Form.Item>
      </div>
    </div>

    <div style={jvmSectionCardStyle()}>
      {renderJvmSectionHeader(
        <ClusterOutlined />,
        t("connection.modal.jvm.accessMode.title"),
        t("connection.modal.jvm.accessMode.description"),
      )}
      <Form.Item
        name="jvmAllowedModes"
        hidden
        rules={[
          {
            required: true,
            message: t("connection.modal.jvm.accessMode.required"),
          },
        ]}
      >
        <Select mode="multiple" />
      </Form.Item>
      <Form.Item
        name="jvmPreferredMode"
        hidden
        rules={[
          {
            required: true,
            message: t("connection.modal.jvm.preferredMode.required"),
          },
        ]}
      >
        <Input {...noAutoCapInputProps} />
      </Form.Item>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
        }}
      >
        {JVM_EDITABLE_MODES.map((mode) => {
          const meta = resolveJVMModeMeta(mode);
          const enabled = normalizedJvmAllowedModes.includes(mode);
          const preferred = jvmPreferredMode === mode;
          return (
            <div
              key={mode}
              role="button"
              tabIndex={0}
              onClick={() => handleJvmModeCardSelect(mode)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleJvmModeCardSelect(mode);
                }
              }}
              aria-pressed={enabled}
              style={{
                textAlign: "left",
                padding: 14,
                borderRadius: 16,
                border: enabled
                  ? darkMode
                    ? "1px solid rgba(255,214,102,0.36)"
                    : "1px solid rgba(22,119,255,0.34)"
                  : darkMode
                    ? "1px solid rgba(255,255,255,0.08)"
                    : "1px solid rgba(16,24,40,0.08)",
                background: enabled
                  ? darkMode
                    ? "rgba(255,214,102,0.08)"
                    : "rgba(22,119,255,0.06)"
                  : darkMode
                    ? "rgba(255,255,255,0.03)"
                    : "rgba(16,24,40,0.03)",
                boxShadow: preferred
                  ? darkMode
                    ? "0 0 0 2px rgba(255,214,102,0.12)"
                    : "0 0 0 2px rgba(22,119,255,0.10)"
                  : "none",
                color: darkMode ? "#f5f7ff" : "#162033",
                cursor: "pointer",
                transition: "all 120ms ease",
              }}
            >
              <Space size={8} wrap>
                <Tag color={enabled ? "blue" : "default"}>
                  {meta.label}
                </Tag>
                {preferred ? (
                  <Tag color="green">
                    {t("connection.modal.jvm.tag.preferred")}
                  </Tag>
                ) : null}
                {!enabled ? (
                  <Tag>{t("connection.modal.jvm.tag.notEnabled")}</Tag>
                ) : null}
              </Space>
              <div style={{ ...modalMutedTextStyle, marginTop: 8 }}>
                {mode === "jmx"
                  ? t("connection.modal.jvm.mode.jmx.description")
                  : mode === "endpoint"
                    ? t(
                        "connection.modal.jvm.mode.endpoint.description",
                      )
                    : t("connection.modal.jvm.mode.agent.description")}
              </div>
              <Button
                size="small"
                type={enabled ? "default" : "primary"}
                disabled={enabled && normalizedJvmAllowedModes.length <= 1}
                onClick={(event) => handleJvmModeToggle(mode, event)}
                style={{ marginTop: 12, borderRadius: 999 }}
              >
                {enabled
                  ? t("connection.modal.jvm.mode.disable")
                  : t("connection.modal.jvm.mode.enablePreferred")}
              </Button>
            </div>
          );
        })}
      </div>
      <div style={{ ...modalMutedTextStyle, marginTop: 12 }}>
        {t("connection.modal.jvm.preferredSummary", {
          mode: resolveJVMModeMeta(String(jvmPreferredMode || "jmx"))
            .label,
        })}
      </div>
    </div>
  </>
);
