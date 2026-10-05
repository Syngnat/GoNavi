import {
  ApiOutlined,
  CodeOutlined,
  ThunderboltOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { t } from "../../i18n";
import { Tag, Form, Input, InputNumber, Switch, Typography, Checkbox } from "antd";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

const { Text } = Typography;

export interface ConnectionStep2JvmDetailCardsProps {
  jvmSectionCardStyle: ConnectionModalStep2Props['jvmSectionCardStyle'];
  renderJvmSectionHeader: ConnectionModalStep2Props['renderJvmSectionHeader'];
  normalizedJvmAllowedModes: ConnectionModalStep2Props['normalizedJvmAllowedModes'];
  jvmPreferredMode: ConnectionModalStep2Props['jvmPreferredMode'];
  jvmDiagnosticEnabled: ConnectionModalStep2Props['jvmDiagnosticEnabled'];
  renderChoiceCards: ConnectionModalStep2Props['renderChoiceCards'];
  jvmDiagnosticTransport: ConnectionModalStep2Props['jvmDiagnosticTransport'];
  darkMode: ConnectionModalStep2Props['darkMode'];
  modalMutedTextStyle: ConnectionModalStep2Props['modalMutedTextStyle'];
}

export const ConnectionStep2JvmDetailCards = ({
  jvmSectionCardStyle,
  renderJvmSectionHeader,
  normalizedJvmAllowedModes,
  jvmPreferredMode,
  jvmDiagnosticEnabled,
  renderChoiceCards,
  jvmDiagnosticTransport,
  darkMode,
  modalMutedTextStyle,
}: ConnectionStep2JvmDetailCardsProps) => (
  <>
    <div style={jvmSectionCardStyle()}>
      {renderJvmSectionHeader(
        <ApiOutlined />,
        "JMX",
        t("connection.modal.jvm.jmx.description"),
        <Tag color={normalizedJvmAllowedModes.includes("jmx") ? "green" : "default"}>
          {normalizedJvmAllowedModes.includes("jmx")
            ? t("connection.modal.jvm.tag.enabled")
            : t("connection.modal.jvm.tag.notEnabled")}
        </Tag>,
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 120px",
          gap: 16,
        }}
      >
        <Form.Item
          name="jvmJmxHost"
          label={t("connection.modal.jvm.jmx.host.label")}
          style={{ marginBottom: 0 }}
        >
          <Input
            {...noAutoCapInputProps}
            disabled={!normalizedJvmAllowedModes.includes("jmx")}
            placeholder={t("connection.modal.jvm.jmx.host.placeholder")}
          />
        </Form.Item>
        <Form.Item
          name="jvmJmxPort"
          label={t("connection.modal.jvm.jmx.port.label")}
          style={{ marginBottom: 0 }}
        >
          <InputNumber
            style={{ width: "100%" }}
            min={1}
            max={65535}
            disabled={!normalizedJvmAllowedModes.includes("jmx")}
            placeholder={t("connection.modal.jvm.jmx.port.placeholder")}
          />
        </Form.Item>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 16,
          marginTop: 16,
        }}
      >
        <Form.Item
          name="jvmJmxUsername"
          label={t("connection.modal.jvm.jmx.username.label")}
          style={{ marginBottom: 0 }}
        >
          <Input
            {...noAutoCapInputProps}
            disabled={!normalizedJvmAllowedModes.includes("jmx")}
            placeholder={t(
              "connection.modal.jvm.jmx.username.placeholder",
            )}
          />
        </Form.Item>
        <Form.Item
          name="jvmJmxPassword"
          label={t("connection.modal.jvm.jmx.password.label")}
          style={{ marginBottom: 0 }}
        >
          <Input.Password
            {...noAutoCapInputProps}
            disabled={!normalizedJvmAllowedModes.includes("jmx")}
            placeholder={t(
              "connection.modal.jvm.jmx.password.placeholder",
            )}
          />
        </Form.Item>
      </div>
    </div>

    <div style={jvmSectionCardStyle()}>
      {renderJvmSectionHeader(
        <CodeOutlined />,
        "Endpoint",
        t("connection.modal.jvm.endpoint.description"),
        <Tag
          color={
            normalizedJvmAllowedModes.includes("endpoint")
              ? "green"
              : "default"
          }
        >
          {normalizedJvmAllowedModes.includes("endpoint")
            ? t("connection.modal.jvm.tag.enabled")
            : t("connection.modal.jvm.tag.notEnabled")}
        </Tag>,
      )}
      <Form.Item
        name="jvmEndpointBaseUrl"
        label={t("connection.modal.jvm.endpoint.address.label")}
        rules={[
          {
            required: jvmPreferredMode === "endpoint",
            message: t(
              "connection.modal.jvm.endpoint.address.required",
            ),
          },
        ]}
        help={t("connection.modal.jvm.endpoint.address.help")}
      >
        <Input
          {...noAutoCapInputProps}
          disabled={!normalizedJvmAllowedModes.includes("endpoint")}
          placeholder={t(
            "connection.modal.jvm.endpoint.address.placeholder",
          )}
        />
      </Form.Item>
      <Form.Item
        name="jvmEndpointApiKey"
        label={t("connection.modal.jvm.endpoint.apiKey.label")}
        style={{ marginBottom: 0 }}
      >
        <Input.Password
          {...noAutoCapInputProps}
          disabled={!normalizedJvmAllowedModes.includes("endpoint")}
          placeholder={t(
            "connection.modal.jvm.endpoint.apiKey.placeholder",
          )}
        />
      </Form.Item>
    </div>

    <div style={jvmSectionCardStyle()}>
      {renderJvmSectionHeader(
        <ThunderboltOutlined />,
        "Agent",
        t("connection.modal.jvm.agent.description"),
        <Tag color={normalizedJvmAllowedModes.includes("agent") ? "green" : "default"}>
          {normalizedJvmAllowedModes.includes("agent")
            ? t("connection.modal.jvm.tag.enabled")
            : t("connection.modal.jvm.tag.notEnabled")}
        </Tag>,
      )}
      <Form.Item
        name="jvmAgentBaseUrl"
        label={t("connection.modal.jvm.agent.address.label")}
        rules={[
          {
            required: jvmPreferredMode === "agent",
            message: t("connection.modal.jvm.agent.address.required"),
          },
        ]}
        help={t("connection.modal.jvm.agent.address.help")}
      >
        <Input
          {...noAutoCapInputProps}
          disabled={!normalizedJvmAllowedModes.includes("agent")}
          placeholder={t(
            "connection.modal.jvm.agent.address.placeholder",
          )}
        />
      </Form.Item>
      <Form.Item
        name="jvmAgentApiKey"
        label={t("connection.modal.jvm.agent.apiKey.label")}
        style={{ marginBottom: 0 }}
      >
        <Input.Password
          {...noAutoCapInputProps}
          disabled={!normalizedJvmAllowedModes.includes("agent")}
          placeholder={t(
            "connection.modal.jvm.agent.apiKey.placeholder",
          )}
        />
      </Form.Item>
    </div>

    <div style={jvmSectionCardStyle()}>
      {renderJvmSectionHeader(
        <SafetyCertificateOutlined />,
        t("connection.modal.jvm.diagnostic.title"),
        t("connection.modal.jvm.diagnostic.description"),
        <Form.Item
          name="jvmDiagnosticEnabled"
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch
            checkedChildren={t("connection.modal.jvm.switch.on")}
            unCheckedChildren={t("connection.modal.jvm.switch.off")}
          />
        </Form.Item>,
      )}
      {jvmDiagnosticEnabled ? (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "220px minmax(0, 1fr)",
              gap: 16,
            }}
          >
            <div style={{ display: "grid", gap: 8 }}>
              <Text strong>
                {t("connection.modal.jvm.diagnostic.transport.label")}
              </Text>
              {renderChoiceCards({
                fieldName: "jvmDiagnosticTransport",
                value: String(jvmDiagnosticTransport),
                options: [
                  {
                    value: "agent-bridge",
                    label: t(
                      "connection.modal.jvm.diagnostic.transport.agent_bridge",
                    ),
                    description: t(
                      "connection.modal.jvm.diagnostic.transport.agentBridge.description",
                    ),
                  },
                  {
                    value: "arthas-tunnel",
                    label: t(
                      "connection.modal.jvm.diagnostic.transport.arthas_tunnel",
                    ),
                    description: t(
                      "connection.modal.jvm.diagnostic.transport.arthasTunnel.description",
                    ),
                  },
                ],
              })}
            </div>
            <Form.Item
              name="jvmDiagnosticBaseUrl"
              label={
                jvmDiagnosticTransport === "arthas-tunnel"
                  ? t(
                      "connection.modal.jvm.diagnostic.arthasTunnelAddress.label",
                    )
                  : t(
                      "connection.modal.jvm.diagnostic.bridgeAddress.label",
                    )
              }
              rules={[
                {
                  required: true,
                  message:
                    jvmDiagnosticTransport === "arthas-tunnel"
                      ? t(
                          "connection.modal.jvm.diagnostic.arthasTunnelAddress.required",
                        )
                      : t(
                          "connection.modal.jvm.diagnostic.bridgeAddress.required",
                        ),
                },
              ]}
              help={
                jvmDiagnosticTransport === "arthas-tunnel"
                  ? t(
                      "connection.modal.jvm.diagnostic.arthasTunnelAddress.help",
                    )
                  : t(
                      "connection.modal.jvm.diagnostic.bridgeAddress.help",
                    )
              }
            >
              <Input
                {...noAutoCapInputProps}
                placeholder={
                  jvmDiagnosticTransport === "arthas-tunnel"
                    ? "http://127.0.0.1:7777"
                    : "http://127.0.0.1:19091/gonavi/diag"
                }
              />
            </Form.Item>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) 220px",
              gap: 16,
            }}
          >
            <Form.Item
              name="jvmDiagnosticTargetId"
              label={
                jvmDiagnosticTransport === "arthas-tunnel"
                  ? t(
                      "connection.modal.jvm.diagnostic.targetId.agentId.label",
                    )
                  : t(
                      "connection.modal.jvm.diagnostic.targetId.label",
                    )
              }
              rules={
                jvmDiagnosticTransport === "arthas-tunnel"
                  ? [
                      {
                        required: true,
                        message: t(
                          "connection.modal.jvm.diagnostic.targetId.required",
                        ),
                      },
                    ]
                  : undefined
              }
              help={
                jvmDiagnosticTransport === "arthas-tunnel"
                  ? t(
                      "connection.modal.jvm.diagnostic.targetId.arthasHelp",
                    )
                  : t(
                      "connection.modal.jvm.diagnostic.targetId.bridgeHelp",
                    )
              }
            >
              <Input
                {...noAutoCapInputProps}
                placeholder={
                  jvmDiagnosticTransport === "arthas-tunnel"
                    ? t("connection.modal.example", {
                        value: "orders-app_A1B2C3D4E5",
                      })
                    : t("connection.modal.example", {
                        value: "orders-prod-01",
                      })
                }
              />
            </Form.Item>
            <Form.Item
              name="jvmDiagnosticTimeoutSeconds"
              label={t(
                "connection.modal.jvm.diagnostic.timeout.label",
              )}
              rules={[
                {
                  type: "number",
                  min: 1,
                  max: 300,
                  message: t(
                    "connection.modal.jvm.diagnostic.timeout.range",
                  ),
                },
              ]}
            >
              <InputNumber style={{ width: "100%" }} min={1} max={300} />
            </Form.Item>
          </div>
          <Form.Item
            name="jvmDiagnosticApiKey"
            label={t("connection.modal.jvm.diagnostic.apiKey.label")}
          >
            <Input.Password
              {...noAutoCapInputProps}
              placeholder={t(
                "connection.modal.jvm.diagnostic.apiKey.placeholder",
              )}
            />
          </Form.Item>
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 10,
            }}
          >
            {[
              {
                name: "jvmDiagnosticAllowObserveCommands",
                label: t(
                  "connection.modal.jvm.diagnostic.command.observe.label",
                ),
                description: t(
                  "connection.modal.jvm.diagnostic.command.observe.description",
                ),
              },
              {
                name: "jvmDiagnosticAllowTraceCommands",
                label: t(
                  "connection.modal.jvm.diagnostic.command.trace.label",
                ),
                description: t(
                  "connection.modal.jvm.diagnostic.command.trace.description",
                ),
              },
              {
                name: "jvmDiagnosticAllowMutatingCommands",
                label: t(
                  "connection.modal.jvm.diagnostic.command.mutating.label",
                ),
                description: t(
                  "connection.modal.jvm.diagnostic.command.mutating.description",
                ),
              },
            ].map((item) => (
              <div
                key={item.name}
                style={{
                  padding: 12,
                  borderRadius: 14,
                  background: darkMode
                    ? "rgba(255,255,255,0.04)"
                    : "rgba(16,24,40,0.04)",
                }}
              >
                <Form.Item
                  name={item.name}
                  valuePropName="checked"
                  style={{ marginBottom: 6 }}
                >
                  <Checkbox>{item.label}</Checkbox>
                </Form.Item>
                <div style={modalMutedTextStyle}>
                  {item.description}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div
          style={{
            ...modalMutedTextStyle,
            padding: "10px 12px",
            borderRadius: 12,
            background: darkMode
              ? "rgba(255,255,255,0.04)"
              : "rgba(16,24,40,0.04)",
          }}
        >
          {t("connection.modal.jvm.diagnostic.disabledHint")}
        </div>
      )}
    </div>
  </>
);
