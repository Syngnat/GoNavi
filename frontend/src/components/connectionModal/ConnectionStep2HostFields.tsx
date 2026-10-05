import { t } from "../../i18n";
import { Form, Input, Button, InputNumber, Select, Radio } from "antd";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { usesTrinoStyleConnection } from "../../utils/dataSourceRegistry/uriScheme";
import {
  CLICKHOUSE_PROTOCOL_OPTIONS,
  OCEANBASE_PROTOCOL_OPTIONS,
} from "./connectionStep2Constants";
import type { ConnectionStep2DenseRowsApi } from "./connectionStep2DenseRows";
import type { ConnectionStep2UriBlockApi } from "./connectionStep2UriBlock";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface ConnectionStep2HostFieldsProps {
  denseIdentityRows: ConnectionStep2DenseRowsApi['denseIdentityRows'];
  denseLabel: ConnectionStep2UriBlockApi['denseLabel'];
  isFileDb: ConnectionModalStep2Props['isFileDb'];
  createUriAwareRequiredRule: ConnectionModalStep2Props['createUriAwareRequiredRule'];
  dbType: ConnectionModalStep2Props['dbType'];
  handleSelectDatabaseFile: ConnectionModalStep2Props['handleSelectDatabaseFile'];
  selectingDbFile: ConnectionModalStep2Props['selectingDbFile'];
  isMySQLLike: ConnectionModalStep2Props['isMySQLLike'];
  clearConnectionTestResultForChoice: ConnectionModalStep2Props['clearConnectionTestResultForChoice'];
  form: ConnectionModalStep2Props['form'];
  isPulsar: ConnectionModalStep2Props['isPulsar'];
  handleOracleModeChange: ConnectionModalStep2Props['handleOracleModeChange'];
  isOceanBaseOracle: ConnectionModalStep2Props['isOceanBaseOracle'];
  oracleMode: ConnectionModalStep2Props['oracleMode'];
}

export const ConnectionStep2HostFields = ({
  denseIdentityRows,
  denseLabel,
  isFileDb,
  createUriAwareRequiredRule,
  dbType,
  handleSelectDatabaseFile,
  selectingDbFile,
  isMySQLLike,
  clearConnectionTestResultForChoice,
  form,
  isPulsar,
  handleOracleModeChange,
  isOceanBaseOracle,
  oracleMode,
}: ConnectionStep2HostFieldsProps) => (
  <>
    {denseIdentityRows}

    {/* 主机 / 文件 · 密排 */}
    <div className="gn-conn-f-row">
      {denseLabel(
        isFileDb
          ? t("connection.modal.dense.file")
          : t("connection.modal.dense.host"),
        isFileDb
          ? t("connection.modal.field.filePath.label")
          : t("connection.modal.field.host.label"),
      )}
      <div className="gn-conn-f-ctrl gn-conn-f-inline">
        <div
          className={`gn-conn-w ${isFileDb ? "gn-conn-w-grow" : "gn-conn-w-host"}`}
        >
          <Form.Item
            name="host"
            rules={[
              createUriAwareRequiredRule(
                t("connection.modal.field.addressPath.required"),
              ),
            ]}
            style={{ marginBottom: 0 }}
          >
            <Input
              {...noAutoCapInputProps}
              placeholder={
                isFileDb
                  ? dbType === "duckdb"
                    ? "/path/to/db.duckdb"
                    : "/path/to/db.sqlite"
                  : "localhost"
              }
            />
          </Form.Item>
        </div>
        {isFileDb ? (
          <Button
            onClick={handleSelectDatabaseFile}
            loading={selectingDbFile}
          >
            {t("connection.modal.action.browse")}
          </Button>
        ) : (
          <div className="gn-conn-w gn-conn-w-port">
            <Form.Item
              name="port"
              rules={[
                createUriAwareRequiredRule(
                  t("connection.modal.field.port.required"),
                  (value: unknown) => Number(value) > 0,
                ),
              ]}
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                style={{ width: "100%" }}
                controls={false}
              />
            </Form.Item>
          </div>
        )}
        {!isFileDb &&
          (isMySQLLike ||
            dbType === "postgres" ||
            dbType === "kingbase" ||
            dbType === "highgo" ||
            dbType === "vastbase" ||
            dbType === "opengauss" ||
            dbType === "gaussdb" ||
            usesTrinoStyleConnection(dbType) ||
            dbType === "mongodb") && (
            <div className="gn-conn-w gn-conn-w-db">
              <Form.Item name="database" style={{ marginBottom: 0 }}>
                <Input
                  {...noAutoCapInputProps}
                  aria-label={t(
                    "connection.modal.field.defaultDatabase.label",
                  )}
                  placeholder={t("connection.modal.dense.db")}
                />
              </Form.Item>
            </div>
          )}
      </div>
    </div>

    {dbType === "nacos" && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.field.nacosNamespaceId.label"),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item
            name="nacosNamespaceId"
            style={{ marginBottom: 0 }}
          >
            <Input
              {...noAutoCapInputProps}
              maxLength={256}
              placeholder={t(
                "connection.modal.field.nacosNamespaceId.placeholder",
              )}
            />
          </Form.Item>
          <div className="gn-conn-mode-hint">
            {t("connection.modal.field.nacosNamespaceId.help")}
          </div>
        </div>
      </div>
    )}

    {dbType === "clickhouse" && (
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.protocol"),
          t("connection.modal.field.protocol.label"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <Form.Item
            name="clickHouseProtocol"
            style={{ marginBottom: 0, minWidth: 140 }}
          >
            <Select
              style={{ minWidth: 140 }}
              options={CLICKHOUSE_PROTOCOL_OPTIONS.map((option) => ({
                ...option,
                label: option.labelKey
                  ? t(option.labelKey)
                  : option.label,
              }))}
              onChange={() => clearConnectionTestResultForChoice()}
            />
          </Form.Item>
        </div>
      </div>
    )}

    {dbType === "oceanbase" && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.protocol"),
          t("connection.modal.field.oceanBaseProtocol.label"),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item
            name="oceanBaseProtocol"
            style={{ marginBottom: 0, minWidth: 140 }}
          >
            <Select
              style={{ minWidth: 140 }}
              options={OCEANBASE_PROTOCOL_OPTIONS}
              onChange={() => {
                form.setFieldsValue({ mysqlTopology: "single" });
                clearConnectionTestResultForChoice();
              }}
            />
          </Form.Item>
          <div className="gn-conn-mode-hint">
            {t("connection.modal.field.oceanBaseProtocol.help.primary")}
          </div>
        </div>
      </div>
    )}

    {(dbType === "kafka" || isPulsar) && (
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.topic"),
          t(isPulsar ? "connection_modal.pulsar.defaultTopic.label" : "connection.modal.messageQueue.kafka.defaultTopic.label"),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item name="database" style={{ marginBottom: 0 }}>
            <Input
              {...noAutoCapInputProps}
              placeholder={t(
                isPulsar ? "connection_modal.pulsar.defaultTopic.placeholder" : "connection.modal.messageQueue.kafka.defaultTopic.placeholder",
              )}
            />
          </Form.Item>
        </div>
      </div>
    )}

    {dbType === "rocketmq" && (
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.topic"),
          t(
            "connection.modal.messageQueue.rocketmq.defaultTopic.label",
          ),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item name="database" style={{ marginBottom: 0 }}>
            <Input
              {...noAutoCapInputProps}
              placeholder={t(
                "connection.modal.messageQueue.rocketmq.defaultTopic.placeholder",
              )}
            />
          </Form.Item>
        </div>
      </div>
    )}

    {dbType === "mqtt" && (
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.topic"),
          t(
            "connection.modal.messageQueue.mqtt.defaultTopicFilter.label",
          ),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item name="database" style={{ marginBottom: 0 }}>
            <Input
              {...noAutoCapInputProps}
              placeholder={t(
                "connection.modal.messageQueue.mqtt.defaultTopicFilter.placeholder",
              )}
            />
          </Form.Item>
        </div>
      </div>
    )}

    {dbType === "rabbitmq" && (
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.vhost"),
          t(
            "connection.modal.messageQueue.rabbitmq.defaultVirtualHost.label",
          ),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item name="database" style={{ marginBottom: 0 }}>
            <Input
              {...noAutoCapInputProps}
              placeholder={t(
                "connection.modal.messageQueue.rabbitmq.defaultVirtualHost.placeholder",
              )}
            />
          </Form.Item>
        </div>
      </div>
    )}

    {dbType === "oracle" && (
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.field.oracleMode.label"),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item name="oracleMode" style={{ marginBottom: 0 }}>
            <Radio.Group onChange={handleOracleModeChange}>
              <Radio value="service">
                {t("connection.modal.field.oracleMode.service")}
              </Radio>
              <Radio value="sid">
                {t("connection.modal.field.oracleMode.sid")}
              </Radio>
            </Radio.Group>
          </Form.Item>
        </div>
      </div>
    )}

    {(dbType === "oracle" || isOceanBaseOracle) && (
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.service"),
          dbType === "oracle" && oracleMode === "sid"
            ? t("connection.modal.field.sid.label")
            : isOceanBaseOracle
              ? t("connection.modal.field.oceanBaseServiceName.label")
              : t("connection.modal.field.serviceName.label"),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item
            name="database"
            rules={
              isOceanBaseOracle
                ? []
                : [
                    createUriAwareRequiredRule(
                      dbType === "oracle" && oracleMode === "sid"
                        ? t("connection.modal.field.sid.required")
                        : t(
                            "connection.modal.field.serviceName.required",
                          ),
                    ),
                  ]
            }
            style={{ marginBottom: 0 }}
          >
            <Input
              {...noAutoCapInputProps}
              placeholder={
                dbType === "oracle" && oracleMode === "sid"
                  ? t("connection.modal.field.sid.placeholder")
                  : t(
                      "connection.modal.field.serviceName.placeholder",
                    )
              }
            />
          </Form.Item>
        </div>
      </div>
    )}
  </>
);
