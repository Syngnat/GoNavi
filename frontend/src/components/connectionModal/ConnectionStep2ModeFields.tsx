import { t } from "../../i18n";
import { Form, Select, Input } from "antd";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { getStoredSecretPlaceholder } from "../../utils/connectionModalPresentation";
import type { ConnectionStep2UriBlockApi } from "./connectionStep2UriBlock";
import type { ConnectionStep2DenseRowsApi } from "./connectionStep2DenseRows";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface ConnectionStep2ModeFieldsProps {
  isMySQLLike: ConnectionModalStep2Props['isMySQLLike'];
  denseLabel: ConnectionStep2UriBlockApi['denseLabel'];
  renderChoiceCards: ConnectionModalStep2Props['renderChoiceCards'];
  mysqlTopology: ConnectionModalStep2Props['mysqlTopology'];
  isKafka: ConnectionModalStep2Props['isKafka'];
  kafkaTopology: ConnectionModalStep2Props['kafkaTopology'];
  isRocketMQ: ConnectionModalStep2Props['isRocketMQ'];
  rocketmqTopology: ConnectionModalStep2Props['rocketmqTopology'];
  isMQTT: ConnectionModalStep2Props['isMQTT'];
  mqttTopology: ConnectionModalStep2Props['mqttTopology'];
  renderClusterHostsExtra: ConnectionStep2DenseRowsApi['renderClusterHostsExtra'];
  initialValues: ConnectionModalStep2Props['initialValues'];
  renderStoredSecretControls: ConnectionModalStep2Props['renderStoredSecretControls'];
  dbType: ConnectionModalStep2Props['dbType'];
  mongoTopology: ConnectionModalStep2Props['mongoTopology'];
}

export const ConnectionStep2ModeFields = ({
  isMySQLLike,
  denseLabel,
  renderChoiceCards,
  mysqlTopology,
  isKafka,
  kafkaTopology,
  isRocketMQ,
  rocketmqTopology,
  isMQTT,
  mqttTopology,
  renderClusterHostsExtra,
  initialValues,
  renderStoredSecretControls,
  dbType,
  mongoTopology,
}: ConnectionStep2ModeFieldsProps) => (
  <>
    {/* 模式分段 · 对齐 Demo mode-seg */}
    {isMySQLLike && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.config_section.connectionMode.title"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "mysqlTopology",
            value: String(mysqlTopology),
            variant: "segment",
            options: [
              {
                value: "single",
                label: t("connection.modal.topology.single.label"),
                description: t(
                  "connection.modal.topology.mysql.single.description",
                ),
              },
              {
                value: "replica",
                label: t(
                  "connection.modal.topology.mysql.replica.label",
                ),
                description: t(
                  "connection.modal.topology.mysql.replica.description",
                ),
              },
            ],
          })}
        </div>
      </div>
    )}

    {isKafka && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.config_section.connectionMode.title"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "kafkaTopology",
            value: String(kafkaTopology),
            variant: "segment",
            options: [
              {
                value: "single",
                label: t(
                  "connection.modal.messageQueue.kafka.topology.single.label",
                ),
                description: t(
                  "connection.modal.messageQueue.kafka.topology.single.description",
                ),
              },
              {
                value: "cluster",
                label: t(
                  "connection.modal.messageQueue.topology.cluster.label",
                ),
                description: t(
                  "connection.modal.messageQueue.kafka.topology.cluster.description",
                ),
              },
            ],
          })}
        </div>
      </div>
    )}

    {isRocketMQ && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.config_section.connectionMode.title"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "rocketmqTopology",
            value: String(rocketmqTopology),
            variant: "segment",
            options: [
              {
                value: "single",
                label: t(
                  "connection.modal.messageQueue.rocketmq.topology.single.label",
                ),
                description: t(
                  "connection.modal.messageQueue.rocketmq.topology.single.description",
                ),
              },
              {
                value: "cluster",
                label: t(
                  "connection.modal.messageQueue.topology.cluster.label",
                ),
                description: t(
                  "connection.modal.messageQueue.rocketmq.topology.cluster.description",
                ),
              },
            ],
          })}
        </div>
      </div>
    )}

    {isMQTT && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.config_section.connectionMode.title"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "mqttTopology",
            value: String(mqttTopology),
            variant: "segment",
            options: [
              {
                value: "single",
                label: t(
                  "connection.modal.messageQueue.mqtt.topology.single.label",
                ),
                description: t(
                  "connection.modal.messageQueue.mqtt.topology.single.description",
                ),
              },
              {
                value: "cluster",
                label: t(
                  "connection.modal.messageQueue.topology.cluster.label",
                ),
                description: t(
                  "connection.modal.messageQueue.mqtt.topology.cluster.description",
                ),
              },
            ],
          })}
        </div>
      </div>
    )}

    {isKafka &&
      kafkaTopology === "cluster" &&
      renderClusterHostsExtra({
        fieldName: "kafkaHosts",
        labelKey: "connection.modal.messageQueue.kafka.extraBrokers.label",
        helpKey: "connection.modal.messageQueue.kafka.extraBrokers.help",
        placeholderKey:
          "connection.modal.messageQueue.kafka.extraBrokers.placeholder",
      })}

    {isRocketMQ &&
      rocketmqTopology === "cluster" &&
      renderClusterHostsExtra({
        fieldName: "rocketmqHosts",
        labelKey:
          "connection.modal.messageQueue.rocketmq.extraNameServers.label",
        helpKey:
          "connection.modal.messageQueue.rocketmq.extraNameServers.help",
        placeholderKey:
          "connection.modal.messageQueue.rocketmq.extraNameServers.placeholder",
      })}

    {isMQTT &&
      mqttTopology === "cluster" &&
      renderClusterHostsExtra({
        fieldName: "mqttHosts",
        labelKey: "connection.modal.messageQueue.mqtt.extraBrokers.label",
        helpKey: "connection.modal.messageQueue.mqtt.extraBrokers.help",
        placeholderKey:
          "connection.modal.messageQueue.mqtt.extraBrokers.placeholder",
      })}

    {isMySQLLike && mysqlTopology === "replica" && (
      <div className="gn-conn-mode-extra">
        <div className="gn-conn-el">
          {t("connection.modal.field.mysqlReplicaHosts.label")}
        </div>
        <div className="gn-conn-eh">
          {t("connection.modal.field.mysqlReplicaHosts.help")}
        </div>
        <Form.Item name="mysqlReplicaHosts" noStyle>
          <Select
            mode="tags"
            placeholder={t(
              "connection.modal.field.mysqlReplicaHosts.placeholder",
            )}
            tokenSeparators={[",", ";", " "]}
          />
        </Form.Item>
        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.auth"),
            t("connection.modal.field.mysqlReplicaUser.label"),
          )}
          <div className="gn-conn-f-ctrl gn-conn-f-inline">
            <div className="gn-conn-w gn-conn-w-user">
              <Form.Item name="mysqlReplicaUser" style={{ marginBottom: 0 }}>
                <Input
                  {...noAutoCapInputProps}
                  placeholder={t(
                    "connection.modal.field.mysqlReplicaUser.placeholder",
                  )}
                />
              </Form.Item>
            </div>
            <div className="gn-conn-w gn-conn-w-pass">
              <Form.Item name="mysqlReplicaPassword" style={{ marginBottom: 0 }}>
                <Input.Password
                  {...noAutoCapInputProps}
                  placeholder={getStoredSecretPlaceholder({
                    hasStoredSecret:
                      initialValues?.hasMySQLReplicaPassword,
                    emptyPlaceholder: t(
                      "connection.modal.field.mysqlReplicaPassword.placeholder",
                    ),
                    retainedLabel: t(
                      "connection.modal.field.mysqlReplicaPassword.retained",
                    ),
                  })}
                />
              </Form.Item>
            </div>
          </div>
        </div>
        {renderStoredSecretControls({
          fieldName: "mysqlReplicaPassword",
          clearKey: "mysqlReplicaPassword",
          hasStoredSecret: initialValues?.hasMySQLReplicaPassword,
          clearLabel: t(
            "connection.modal.field.mysqlReplicaPassword.clear",
          ),
          description: t(
            "connection.modal.field.mysqlReplicaPassword.savedDescription",
          ),
        })}
      </div>
    )}

    {dbType === "mongodb" && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.config_section.connectionMode.title"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "mongoTopology",
            value: String(mongoTopology),
            variant: "segment",
            options: [
              {
                value: "single",
                label: t("connection.modal.topology.single.label"),
                description: t(
                  "connection.modal.topology.mongodb.single.description",
                ),
              },
              {
                value: "replica",
                label: t(
                  "connection.modal.topology.mongodb.replica.label",
                ),
                description: t(
                  "connection.modal.topology.mongodb.replica.description",
                ),
              },
            ],
          })}
        </div>
      </div>
    )}
  </>
);
