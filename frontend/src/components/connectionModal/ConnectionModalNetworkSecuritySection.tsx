import React, { type ReactNode } from "react";
import { Button, Checkbox, Form, Input, InputNumber, Select } from "antd";

import { t } from "../../i18n";
import { getStoredSecretPlaceholder } from "../../utils/connectionModalPresentation";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import {
  isSingleReadOnlyConnectionQuery,
  MAX_CONNECTION_KEEPALIVE_SQL_LENGTH,
  supportsConnectionKeepAliveSQL,
} from "../../utils/connectionReadOnly";

const DEFAULT_KEEPALIVE_INTERVAL_MINUTES = 240;
const MIN_KEEPALIVE_INTERVAL_MINUTES = 1;
const MAX_KEEPALIVE_INTERVAL_MINUTES = 1440;

type ConnectionModalNetworkSecuritySectionProps = Record<string, any>;

/** Demo #a-net-detail 的密排标签：短词可见 + 完整标题挂 title，避免窄列换行。 */
const denseLabel = (shortText: string, fullTitle?: string) => (
  <span className="gn-conn-f-label" title={fullTitle || shortText}>
    {shortText}
  </span>
);

const ConnectionModalNetworkSecuritySection: React.FC<ConnectionModalNetworkSecuritySectionProps> = (props) => {
  const {
    activeNetworkConfig,
    dbType,
    form,
    handleSelectCertificateFile,
    handleSelectSSHKeyFile,
    initialValues,
    isFileDb,
    isJVM,
    isSSLType,
    renderStoredSecretControls,
    proxyType,
    selectingCertificateField,
    selectingSSHKey,
    setActiveNetworkConfig,
    sslHintText,
    sslMode,
    supportsSSLCAPath,
    supportsSSLClientCertificate,
    useHttpTunnel,
    useProxy,
    useSSH,
    useSSL,
  } = props;

  if (isFileDb || isJVM) {
    return null;
  }

  const effectiveUseSSL = useSSL || !!form.getFieldValue("useSSL");
  const effectiveUseSSH = useSSH || !!form.getFieldValue("useSSH");
  const effectiveUseHttpTunnel =
    useHttpTunnel || !!form.getFieldValue("useHttpTunnel");
  const effectiveUseProxy =
    !effectiveUseHttpTunnel &&
    (useProxy || !!form.getFieldValue("useProxy"));
  const keepAliveEnabled = !!Form.useWatch("keepAliveEnabled", form);
  const connectionDriver = Form.useWatch("driver", form);
  const oceanBaseProtocol = Form.useWatch("oceanBaseProtocol", form);
  const keepAliveSQLSupported = supportsConnectionKeepAliveSQL({
    type: dbType,
    driver: connectionDriver,
    oceanBaseProtocol: oceanBaseProtocol,
  });

  const networkItems: Array<{
    key: "ssl" | "ssh" | "proxy" | "httpTunnel";
    title: string;
    description: string;
    enabled: boolean;
    disabledHint: string;
  }> = [
    ...(isSSLType
      ? [
          {
            key: "ssl" as const,
            title: t("connection.modal.network.ssl_tls"),
            description: t("connection.modal.network.ssl.description"),
            enabled: effectiveUseSSL,
            disabledHint: t("connection.modal.network.ssl.disabledHint"),
          },
        ]
      : []),
    {
      key: "ssh",
      title: t("connection.modal.network.ssh.title"),
      description: t("connection.modal.network.ssh.description"),
      enabled: effectiveUseSSH,
      disabledHint: t("connection.modal.network.ssh.disabledHint"),
    },
    {
      key: "proxy",
      title: t("connection.modal.network.proxy.title"),
      description: t("connection.modal.network.proxy.description"),
      enabled: effectiveUseProxy,
      disabledHint: t("connection.modal.network.proxy.disabledHint"),
    },
    {
      key: "httpTunnel",
      title: t("connection.modal.network.httpTunnel.title"),
      description: t("connection.modal.network.httpTunnel.description"),
      enabled: effectiveUseHttpTunnel,
      disabledHint: t("connection.modal.network.httpTunnel.disabledHint"),
    },
  ];

  const resolvedNetworkConfig =
    activeNetworkConfig === "ssl" && !effectiveUseSSL
      ? networkItems.find((item) => item.enabled)?.key ||
        (networkItems.some((item) => item.key === activeNetworkConfig)
          ? activeNetworkConfig
          : networkItems[0]?.key || "ssh")
      : networkItems.some((item) => item.key === activeNetworkConfig)
        ? activeNetworkConfig
        : networkItems[0]?.key || "ssh";

  const activeItem =
    networkItems.find((item) => item.key === resolvedNetworkConfig) ||
    networkItems[0];

  /** Demo .path-pick：输入框 + 浏览按钮。 */
  const renderPathPick = (
    fieldName: string,
    placeholder: string,
    onBrowse: () => void,
    loading: boolean,
  ) => (
    <div className="gn-conn-path-pick">
      <Form.Item name={fieldName} noStyle>
        <Input {...noAutoCapInputProps} placeholder={placeholder} />
      </Form.Item>
      <Button onClick={onBrowse} loading={loading}>
        {t("connection.modal.action.browse")}
      </Button>
    </div>
  );

  const renderSSLFields = (): ReactNode => (
    <>
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.network.ssl.mode"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-md">
            <Form.Item name="sslMode" style={{ marginBottom: 0 }}>
              <Select
                value={String(sslMode)}
                options={[
                  {
                    value: "preferred",
                    label: t("connection.modal.network.ssl_mode.preferred"),
                  },
                  {
                    value: "required",
                    label: t("connection.modal.network.ssl_mode.required"),
                  },
                  {
                    value: "skip-verify",
                    label: t("connection.modal.network.ssl_mode.skip_verify"),
                  },
                ]}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      {supportsSSLCAPath && (
        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.ca"),
            dbType === "sqlserver"
              ? t("connection.modal.network.ssl.serverCaPath")
              : t("connection.modal.network.ssl.caPath"),
          )}
          <div className="gn-conn-f-ctrl">
            {renderPathPick(
              "sslCAPath",
              t("connection.modal.example", { value: "C:\\certs\\ca.pem" }),
              () => handleSelectCertificateFile("sslCAPath", "ca"),
              selectingCertificateField === "sslCAPath",
            )}
          </div>
        </div>
      )}
      {supportsSSLClientCertificate && (
        <>
          <div className="gn-conn-f-row">
            {denseLabel(
              t("connection.modal.dense.cert"),
              dbType === "dameng"
                ? t("connection.modal.network.ssl.damengCertPath")
                : t("connection.modal.network.ssl.certPath"),
            )}
            <div className="gn-conn-f-ctrl">
              {renderPathPick(
                "sslCertPath",
                t("connection.modal.example", {
                  value: "C:\\certs\\client-cert.pem",
                }),
                () => handleSelectCertificateFile("sslCertPath", "client-cert"),
                selectingCertificateField === "sslCertPath",
              )}
            </div>
          </div>
          <div className="gn-conn-f-row">
            {denseLabel(
              t("connection.modal.dense.key"),
              dbType === "dameng"
                ? t("connection.modal.network.ssl.damengKeyPath")
                : t("connection.modal.network.ssl.keyPath"),
            )}
            <div className="gn-conn-f-ctrl">
              {renderPathPick(
                "sslKeyPath",
                t("connection.modal.example", {
                  value: "C:\\certs\\client-key.pem",
                }),
                () => handleSelectCertificateFile("sslKeyPath", "client-key"),
                selectingCertificateField === "sslKeyPath",
              )}
            </div>
          </div>
        </>
      )}
      {sslHintText ? (
        <div className="gn-conn-field-hint">{sslHintText}</div>
      ) : null}
    </>
  );

  const renderSSHFields = (): ReactNode => (
    <>
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.host"),
          t("connection.modal.network.ssh.host"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-host">
            <Form.Item
              name="sshHost"
              rules={[
                {
                  required: useSSH,
                  message: t("connection.modal.network.ssh.hostRequired"),
                },
              ]}
              style={{ marginBottom: 0 }}
            >
              <Input
                {...noAutoCapInputProps}
                placeholder={t("connection.modal.example.or", {
                  first: "ssh.example.com",
                  second: "192.168.1.100",
                })}
              />
            </Form.Item>
          </div>
          <div className="gn-conn-w gn-conn-w-port">
            <Form.Item
              name="sshPort"
              rules={[
                {
                  required: useSSH,
                  message: t("connection.modal.network.ssh.portRequired"),
                },
              ]}
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                style={{ width: "100%" }}
                controls={false}
                aria-label={t("connection.modal.field.port.label")}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.user"),
          t("connection.modal.network.ssh.user"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-user">
            <Form.Item
              name="sshUser"
              rules={[
                {
                  required: useSSH,
                  message: t("connection.modal.network.ssh.userRequired"),
                },
              ]}
              style={{ marginBottom: 0 }}
            >
              <Input
                {...noAutoCapInputProps}
                placeholder={t("connection.modal.example", { value: "root" })}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.password"),
          t("connection.modal.network.ssh.password"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-pass">
            <Form.Item name="sshPassword" style={{ marginBottom: 0 }}>
              <Input.Password
                {...noAutoCapInputProps}
                placeholder={getStoredSecretPlaceholder({
                  hasStoredSecret: initialValues?.hasSSHPassword,
                  emptyPlaceholder: t(
                    "connection.modal.field.password.placeholder",
                  ),
                  retainedLabel: t("connection.modal.network.ssh.retained"),
                })}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.key"),
          t("connection.modal.network.ssh.keyPath"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderPathPick(
            "sshKeyPath",
            t("connection.modal.network.ssh.keyPathPlaceholder"),
            handleSelectSSHKeyFile,
            selectingSSHKey,
          )}
        </div>
      </div>
      {renderStoredSecretControls({
        fieldName: "sshPassword",
        clearKey: "sshPassword",
        hasStoredSecret: initialValues?.hasSSHPassword,
        clearLabel: t("connection.modal.network.ssh.clearPassword"),
        description: t("connection.modal.network.ssh.savedDescription"),
      })}
    </>
  );

  const renderProxyFields = (): ReactNode => (
    <>
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.type"),
          t("connection.modal.network.proxy.type"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-sm">
            <Form.Item name="proxyType" style={{ marginBottom: 0 }}>
              <Select
                value={String(proxyType)}
                options={[
                  { value: "socks5", label: "SOCKS5" },
                  { value: "http", label: "HTTP CONNECT" },
                ]}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.address"),
          t("connection.modal.network.proxy.host"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-host">
            <Form.Item
              name="proxyHost"
              rules={[
                {
                  required: useProxy,
                  message: t("connection.modal.network.proxy.hostRequired"),
                },
              ]}
              style={{ marginBottom: 0 }}
            >
              <Input
                {...noAutoCapInputProps}
                placeholder={t("connection.modal.example.or", {
                  first: "127.0.0.1",
                  second: "proxy.company.com",
                })}
              />
            </Form.Item>
          </div>
          <div className="gn-conn-w gn-conn-w-port">
            <Form.Item
              name="proxyPort"
              rules={[
                {
                  required: useProxy,
                  message: t("connection.modal.network.proxy.portRequired"),
                },
              ]}
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                style={{ width: "100%" }}
                controls={false}
                min={1}
                max={65535}
                aria-label={t("connection.modal.field.port.label")}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      <div className="gn-conn-f-row">
        {denseLabel(t("connection.modal.dense.auth"))}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-user">
            <Form.Item name="proxyUser" style={{ marginBottom: 0 }}>
              <Input
                {...noAutoCapInputProps}
                placeholder={t("connection.modal.network.proxy.noAuth")}
              />
            </Form.Item>
          </div>
          <div className="gn-conn-w gn-conn-w-pass">
            <Form.Item name="proxyPassword" style={{ marginBottom: 0 }}>
              <Input.Password
                {...noAutoCapInputProps}
                placeholder={getStoredSecretPlaceholder({
                  hasStoredSecret: initialValues?.hasProxyPassword,
                  emptyPlaceholder: t("connection.modal.network.proxy.noAuth"),
                  retainedLabel: t("connection.modal.network.proxy.retained"),
                })}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      {renderStoredSecretControls({
        fieldName: "proxyPassword",
        clearKey: "proxyPassword",
        hasStoredSecret: initialValues?.hasProxyPassword,
        clearLabel: t("connection.modal.network.proxy.clearPassword"),
        description: t("connection.modal.network.proxy.savedDescription"),
      })}
    </>
  );

  const renderHttpTunnelFields = (): ReactNode => (
    <>
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.address"),
          t("connection.modal.network.httpTunnel.host"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-host">
            <Form.Item
              name="httpTunnelHost"
              rules={[
                {
                  required: useHttpTunnel,
                  message: t(
                    "connection.modal.network.httpTunnel.hostRequired",
                  ),
                },
              ]}
              style={{ marginBottom: 0 }}
            >
              <Input
                {...noAutoCapInputProps}
                placeholder={t("connection.modal.example.or", {
                  first: "tunnel.company.com",
                  second: "127.0.0.1",
                })}
              />
            </Form.Item>
          </div>
          <div className="gn-conn-w gn-conn-w-port">
            <Form.Item
              name="httpTunnelPort"
              rules={[
                {
                  required: useHttpTunnel,
                  message: t(
                    "connection.modal.network.httpTunnel.portRequired",
                  ),
                },
              ]}
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                style={{ width: "100%" }}
                controls={false}
                min={1}
                max={65535}
                aria-label={t("connection.modal.field.port.label")}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      <div className="gn-conn-f-row">
        {denseLabel(t("connection.modal.dense.auth"))}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-user">
            <Form.Item name="httpTunnelUser" style={{ marginBottom: 0 }}>
              <Input
                {...noAutoCapInputProps}
                placeholder={t("connection.modal.network.proxy.noAuth")}
              />
            </Form.Item>
          </div>
          <div className="gn-conn-w gn-conn-w-pass">
            <Form.Item name="httpTunnelPassword" style={{ marginBottom: 0 }}>
              <Input.Password
                {...noAutoCapInputProps}
                placeholder={getStoredSecretPlaceholder({
                  hasStoredSecret: initialValues?.hasHttpTunnelPassword,
                  emptyPlaceholder: t("connection.modal.network.proxy.noAuth"),
                  retainedLabel: t(
                    "connection.modal.network.httpTunnel.retained",
                  ),
                })}
              />
            </Form.Item>
          </div>
        </div>
      </div>
      {renderStoredSecretControls({
        fieldName: "httpTunnelPassword",
        clearKey: "httpTunnelPassword",
        hasStoredSecret: initialValues?.hasHttpTunnelPassword,
        clearLabel: t("connection.modal.network.httpTunnel.clearPassword"),
        description: t("connection.modal.network.httpTunnel.savedDescription"),
      })}
      <div className="gn-conn-field-hint">
        {t("connection.modal.network.httpTunnel.exclusiveHint")}
      </div>
    </>
  );

  const renderNetworkPanelBody = (): ReactNode => {
    if (!activeItem) return null;
    if (!activeItem.enabled) {
      return (
        <div className="empty-hint">
          <div>{activeItem.disabledHint}</div>
          {activeItem.key === "ssl" && sslHintText ? (
            <div style={{ marginTop: 8 }}>{sslHintText}</div>
          ) : null}
        </div>
      );
    }
    switch (activeItem.key) {
      case "ssl":
        return renderSSLFields();
      case "ssh":
        return renderSSHFields();
      case "proxy":
        return renderProxyFields();
      default:
        return renderHttpTunnelFields();
    }
  };

  return (
    <div className="gn-conn-dense">
      <div className="gn-conn-net-hint">
        {t("connection.modal.network.listHint")}
      </div>
      <div className="gn-conn-net-list">
        {networkItems.map((item) => {
          const active = item.key === resolvedNetworkConfig;
          return (
            <div
              key={item.key}
              role="button"
              tabIndex={0}
              className="gn-conn-net-row"
              data-active={active ? "true" : "false"}
              onClick={() => setActiveNetworkConfig(item.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveNetworkConfig(item.key);
                }
              }}
            >
              <Form.Item
                name={
                  item.key === "ssl"
                    ? "useSSL"
                    : item.key === "ssh"
                      ? "useSSH"
                      : item.key === "proxy"
                        ? "useProxy"
                        : "useHttpTunnel"
                }
                valuePropName="checked"
                noStyle
              >
                <Checkbox
                  className="gn-check"
                  onClick={(event) => {
                    // 勾选时保留在当前行，同时展开详情
                    event.stopPropagation();
                    setActiveNetworkConfig(item.key);
                  }}
                />
              </Form.Item>
              <div style={{ minWidth: 0 }}>
                <div className="nt">{item.title}</div>
                <div className="nd">{item.description}</div>
              </div>
              <span className={`st${item.enabled ? " on" : ""}`}>
                {item.enabled
                  ? t("connection.modal.network.enabled")
                  : t("connection.modal.network.notEnabled")}
              </span>
            </div>
          );
        })}
      </div>

      {activeItem ? (
        <div className="gn-conn-net-detail">
          <h4>
            {activeItem.title}
            {activeItem.enabled ? (
              <span className="on">· {t("connection.modal.network.enabled")}</span>
            ) : null}
          </h4>
          <p className="ndesc">{activeItem.description}</p>
          {renderNetworkPanelBody()}
        </div>
      ) : null}

      {/* Demo #a-keepalive-block：高级连接（超时与探活） */}
      <div className="gn-conn-uri-block" style={{ marginBottom: 0 }}>
        <div className="gn-conn-uri-block-top">
          <div>
            <span className="ttl">
              {t("connection.modal.network.advanced.title")}
            </span>
            <span className="hint">
              {t("connection.modal.network.timeout.label")}
            </span>
          </div>
        </div>
        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.timeout"),
            t("connection.modal.network.timeout.label"),
          )}
          <div className="gn-conn-f-ctrl gn-conn-f-inline">
            <div className="gn-conn-w gn-conn-w-port">
              <Form.Item
                name="timeout"
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
                  controls={false}
                  min={1}
                  max={300}
                  aria-label={t("connection.modal.network.timeout.label")}
                />
              </Form.Item>
            </div>
            <span className="gn-conn-unit-hint">
              {t("connection.modal.unit.seconds")}
            </span>
          </div>
        </div>
        <div className="gn-conn-check-line" style={{ paddingLeft: 0 }}>
          <Form.Item
            name="keepAliveEnabled"
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Checkbox className="gn-check">
              {t("connection.modal.network.keepAliveEnabled.checkbox")}
            </Checkbox>
          </Form.Item>
        </div>
        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.interval"),
            t("connection.modal.network.keepAliveInterval.label"),
          )}
          <div className="gn-conn-f-ctrl gn-conn-f-inline">
            <div className="gn-conn-w gn-conn-w-port">
              <Form.Item
                name="keepAliveIntervalMinutes"
                rules={[
                  {
                    type: "number",
                    min: MIN_KEEPALIVE_INTERVAL_MINUTES,
                    max: MAX_KEEPALIVE_INTERVAL_MINUTES,
                    message: t(
                      "connection.modal.network.keepAliveInterval.range",
                    ),
                  },
                ]}
                style={{ marginBottom: 0 }}
              >
                <InputNumber
                  style={{ width: "100%" }}
                  controls={false}
                  min={MIN_KEEPALIVE_INTERVAL_MINUTES}
                  max={MAX_KEEPALIVE_INTERVAL_MINUTES}
                  disabled={!keepAliveEnabled}
                  aria-label={t(
                    "connection.modal.network.keepAliveInterval.label",
                  )}
                  placeholder={String(DEFAULT_KEEPALIVE_INTERVAL_MINUTES)}
                />
              </Form.Item>
            </div>
            <span className="gn-conn-unit-hint">
              {t("connection.modal.unit.minutes")}
            </span>
          </div>
        </div>
        {keepAliveSQLSupported ? (
          <>
            <div
              style={{
                fontSize: 12,
                fontWeight: 650,
                color: "var(--gn-fg-3)",
                marginBottom: 4,
              }}
            >
              {t("connection.modal.network.keepAliveSQL.label")}
            </div>
            <Form.Item
              name="keepAliveSQL"
              rules={[
                {
                  max: MAX_CONNECTION_KEEPALIVE_SQL_LENGTH,
                  message: t("connection.modal.network.keepAliveSQL.maxLength"),
                },
                {
                  validator: (_, value) => {
                    const sql = String(value || "").trim();
                    if (
                      !sql ||
                      !keepAliveEnabled ||
                      isSingleReadOnlyConnectionQuery(
                        {
                          type: dbType,
                          driver: connectionDriver,
                          oceanBaseProtocol: oceanBaseProtocol,
                        },
                        sql,
                      )
                    ) {
                      return Promise.resolve();
                    }
                    return Promise.reject(
                      new Error(
                        t("connection.modal.network.keepAliveSQL.readOnly"),
                      ),
                    );
                  },
                },
              ]}
              style={{ marginBottom: 22 }}
            >
              <Input.TextArea
                {...noAutoCapInputProps}
                autoSize={{ minRows: 2, maxRows: 4 }}
                disabled={!keepAliveEnabled}
                maxLength={MAX_CONNECTION_KEEPALIVE_SQL_LENGTH}
                placeholder="SELECT 1"
                showCount
              />
            </Form.Item>
            <div className="gn-conn-field-hint">
              {t("connection.modal.network.keepAliveSQL.help")}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default ConnectionModalNetworkSecuritySection;
