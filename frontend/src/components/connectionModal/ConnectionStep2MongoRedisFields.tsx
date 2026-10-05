import { t } from "../../i18n";
import { Alert, Form, Select, Input, Space, Button, Table, Tag } from "antd";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { getStoredSecretPlaceholder } from "../../utils/connectionModalPresentation";
import type { MongoMemberInfo } from "../../types";
import type { ConnectionStep2UriBlockApi } from "./connectionStep2UriBlock";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface ConnectionStep2MongoRedisFieldsProps {
  dbType: ConnectionModalStep2Props['dbType'];
  denseLabel: ConnectionStep2UriBlockApi['denseLabel'];
  renderChoiceCards: ConnectionModalStep2Props['renderChoiceCards'];
  mongoSrv: ConnectionModalStep2Props['mongoSrv'];
  setChoiceFieldValue: ConnectionModalStep2Props['setChoiceFieldValue'];
  useSSH: ConnectionModalStep2Props['useSSH'];
  mongoTopology: ConnectionModalStep2Props['mongoTopology'];
  initialValues: ConnectionModalStep2Props['initialValues'];
  renderStoredSecretControls: ConnectionModalStep2Props['renderStoredSecretControls'];
  handleDiscoverMongoMembers: ConnectionModalStep2Props['handleDiscoverMongoMembers'];
  discoveringMembers: ConnectionModalStep2Props['discoveringMembers'];
  mongoMembers: ConnectionModalStep2Props['mongoMembers'];
  mongoReadPreference: ConnectionModalStep2Props['mongoReadPreference'];
  isRedis: ConnectionModalStep2Props['isRedis'];
  redisTopology: ConnectionModalStep2Props['redisTopology'];
  createUriAwareRequiredRule: ConnectionModalStep2Props['createUriAwareRequiredRule'];
  redisDbList: ConnectionModalStep2Props['redisDbList'];
  mongoAuthMechanism: ConnectionModalStep2Props['mongoAuthMechanism'];
}

export const ConnectionStep2MongoRedisFields = ({
  dbType,
  denseLabel,
  renderChoiceCards,
  mongoSrv,
  setChoiceFieldValue,
  useSSH,
  mongoTopology,
  initialValues,
  renderStoredSecretControls,
  handleDiscoverMongoMembers,
  discoveringMembers,
  mongoMembers,
  mongoReadPreference,
  isRedis,
  redisTopology,
  createUriAwareRequiredRule,
  redisDbList,
  mongoAuthMechanism,
}: ConnectionStep2MongoRedisFieldsProps) => (
  <>
    {dbType === "mongodb" && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.address"),
          t("connection.modal.config_section.mongoDiscovery.title"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "mongoSrv",
            value: mongoSrv ? "true" : "false",
            variant: "segment",
            onSelect: (value: string) =>
              setChoiceFieldValue("mongoSrv", value === "true"),
            options: [
              {
                value: "false",
                label: t(
                  "connection.modal.mongo.discovery.standard.label",
                ),
                description: t(
                  "connection.modal.mongo.discovery.standard.description",
                ),
              },
              {
                value: "true",
                label: t(
                  "connection.modal.mongo.discovery.srv.label",
                ),
                description: t(
                  "connection.modal.mongo.discovery.srv.description",
                ),
              },
            ],
          })}
          {mongoSrv && useSSH && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message={t(
                "connection.modal.mongo.discovery.srvSshWarning",
              )}
            />
          )}
        </div>
      </div>
    )}

    {dbType === "mongodb" && mongoTopology === "replica" && (
      <div className="gn-conn-mode-extra">
        <div className="gn-conn-el">
          {mongoSrv
            ? t("connection.modal.field.mongoSrvHosts.label")
            : t("connection.modal.field.mongoHosts.label")}
        </div>
        <div className="gn-conn-eh">
          {mongoSrv
            ? t("connection.modal.field.mongoSrvHosts.help")
            : t("connection.modal.field.mongoHosts.help")}
        </div>
        <Form.Item name="mongoHosts" noStyle>
          <Select
            mode="tags"
            placeholder={
              mongoSrv
                ? t("connection.modal.field.mongoSrvHosts.placeholder")
                : t("connection.modal.field.mongoHosts.placeholder")
            }
            tokenSeparators={[",", ";", " "]}
          />
        </Form.Item>

        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.name"),
            t("connection.modal.field.mongoReplicaSet.label"),
          )}
          <div className="gn-conn-f-ctrl">
            <div className="gn-conn-w gn-conn-w-name">
              <Form.Item
                name="mongoReplicaSet"
                style={{ marginBottom: 0 }}
              >
                <Input
                  {...noAutoCapInputProps}
                  placeholder={t(
                    "connection.modal.field.mongoReplicaSet.placeholder",
                  )}
                />
              </Form.Item>
            </div>
          </div>
        </div>

        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.auth"),
            t("connection.modal.field.mongoReplicaUser.label"),
          )}
          <div className="gn-conn-f-ctrl gn-conn-f-inline">
            <div className="gn-conn-w gn-conn-w-user">
              <Form.Item
                name="mongoReplicaUser"
                style={{ marginBottom: 0 }}
              >
                <Input
                  {...noAutoCapInputProps}
                  placeholder={t(
                    "connection.modal.field.mongoReplicaUser.placeholder",
                  )}
                />
              </Form.Item>
            </div>
            <div className="gn-conn-w gn-conn-w-pass">
              <Form.Item
                name="mongoReplicaPassword"
                style={{ marginBottom: 0 }}
              >
                <Input.Password
                  {...noAutoCapInputProps}
                  placeholder={getStoredSecretPlaceholder({
                    hasStoredSecret:
                      initialValues?.hasMongoReplicaPassword,
                    emptyPlaceholder: t(
                      "connection.modal.field.mongoReplicaPassword.placeholder",
                    ),
                    retainedLabel: t(
                      "connection.modal.field.mongoReplicaPassword.retained",
                    ),
                  })}
                />
              </Form.Item>
            </div>
          </div>
        </div>
        {renderStoredSecretControls({
          fieldName: "mongoReplicaPassword",
          clearKey: "mongoReplicaPassword",
          hasStoredSecret: initialValues?.hasMongoReplicaPassword,
          clearLabel: t(
            "connection.modal.field.mongoReplicaPassword.clear",
          ),
          description: t(
            "connection.modal.field.mongoReplicaPassword.savedDescription",
          ),
        })}

        <Space size={8} style={{ marginTop: 12, marginBottom: 12 }}>
          <Button
            onClick={handleDiscoverMongoMembers}
            loading={discoveringMembers}
          >
            {t("connection.modal.mongo.discoverMembers")}
          </Button>
        </Space>
        {mongoMembers.length > 0 && (
          <Table
            size="small"
            rowKey={(record) => record.host}
            pagination={false}
            dataSource={mongoMembers}
            style={{ marginBottom: 12 }}
            columns={[
              {
                title: t("connection.modal.field.host.label"),
                dataIndex: "host",
                width: "48%",
              },
              {
                title: t("connection.modal.mongo.member.role"),
                dataIndex: "role",
                width: "32%",
                render: (value: string, record: MongoMemberInfo) => (
                  <Tag color={record.isSelf ? "blue" : "default"}>
                    {value || record.state || t("common.unknown")}
                  </Tag>
                ),
              },
              {
                title: t("connection.modal.mongo.member.health"),
                dataIndex: "healthy",
                width: "20%",
                render: (value: boolean) => (
                  <Tag color={value ? "success" : "error"}>
                    {value
                      ? t("connection.modal.mongo.member.healthy")
                      : t("connection.modal.mongo.member.unhealthy")}
                  </Tag>
                ),
              },
            ]}
          />
        )}
      </div>
    )}

    {dbType === "mongodb" && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.auth"),
          t("connection.modal.field.mongoAuthSource.label"),
        )}
        <div className="gn-conn-f-ctrl gn-conn-f-inline">
          <div className="gn-conn-w gn-conn-w-name">
            <Form.Item name="mongoAuthSource" style={{ marginBottom: 0 }}>
              <Input
                {...noAutoCapInputProps}
                placeholder={t(
                  "connection.modal.field.mongoAuthSource.placeholder",
                )}
              />
            </Form.Item>
          </div>
        </div>
      </div>
    )}

    {dbType === "mongodb" && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.mongo.readPreference.label"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "mongoReadPreference",
            value: String(mongoReadPreference),
            variant: "segment",
            options: [
              {
                value: "primary",
                label: "primary",
                description: t(
                  "connection.modal.mongo.readPreference.primary.description",
                ),
              },
              {
                value: "primaryPreferred",
                label: "primaryPreferred",
                description: t(
                  "connection.modal.mongo.readPreference.primaryPreferred.description",
                ),
              },
              {
                value: "secondary",
                label: "secondary",
                description: t(
                  "connection.modal.mongo.readPreference.secondary.description",
                ),
              },
              {
                value: "secondaryPreferred",
                label: "secondaryPreferred",
                description: t(
                  "connection.modal.mongo.readPreference.secondaryPreferred.description",
                ),
              },
              {
                value: "nearest",
                label: "nearest",
                description: t(
                  "connection.modal.mongo.readPreference.nearest.description",
                ),
              },
            ],
          })}
        </div>
      </div>
    )}

    {isRedis && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.mode"),
          t("connection.modal.config_section.connectionMode.title"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "redisTopology",
            value: String(redisTopology),
            variant: "segment",
            options: [
              {
                value: "single",
                label: t("connection.modal.topology.single.label"),
                description: t(
                  "connection.modal.topology.redis.single.description",
                ),
              },
              {
                value: "cluster",
                label: t(
                  "connection.modal.topology.redis.cluster.label",
                ),
                description: t(
                  "connection.modal.topology.redis.cluster.description",
                ),
              },
              {
                value: "sentinel",
                label: t(
                  "connection.modal.redis.topology.sentinel.label",
                ),
                description: t(
                  "connection.modal.redis.topology.sentinel.description",
                ),
              },
            ],
          })}
          {redisTopology === "cluster" && (
            <div
              className="gn-conn-mode-extra"
              style={{ width: "100%" }}
            >
              <div className="gn-conn-el">
                {t("connection.modal.field.redisHosts.label")}
              </div>
              <div className="gn-conn-eh">
                {t("connection.modal.field.redisHosts.help")}
              </div>
              <Form.Item name="redisHosts" noStyle>
                <Select
                  mode="tags"
                  placeholder={t(
                    "connection.modal.field.redisHosts.placeholder",
                  )}
                  tokenSeparators={[",", ";", " "]}
                />
              </Form.Item>
            </div>
          )}
          {redisTopology === "sentinel" && (
            <div
              className="gn-conn-mode-extra"
              style={{ width: "100%" }}
            >
              <div className="gn-conn-el">
                {t("connection.modal.redis.hosts.sentinel.label")}
              </div>
              <div className="gn-conn-eh">
                {t("connection.modal.redis.hosts.sentinel.help")}
              </div>
              <Form.Item name="redisHosts" noStyle>
                <Select
                  mode="tags"
                  placeholder={t(
                    "connection.modal.redis.hosts.sentinel.placeholder",
                  )}
                  tokenSeparators={[",", ";", " "]}
                />
              </Form.Item>
              <div className="gn-conn-el">
                {t("connection.modal.redis.sentinel.master.label")}
              </div>
              <div className="gn-conn-eh">
                {t("connection.modal.redis.sentinel.master.help")}
              </div>
              <Form.Item
                name="redisSentinelMaster"
                style={{ marginBottom: 0 }}
                rules={[
                  createUriAwareRequiredRule(
                    t(
                      "connection.modal.redis.sentinel.master.required",
                    ),
                  ),
                ]}
              >
                <Input
                  {...noAutoCapInputProps}
                  placeholder={t(
                    "connection.modal.redis.sentinel.master.placeholder",
                  )}
                />
              </Form.Item>
            </div>
          )}
        </div>
      </div>
    )}

    {isRedis && (
      <div className="gn-conn-f-row">
        {denseLabel(
          t("connection.modal.dense.scope"),
          t("connection.modal.field.displayDatabases.label"),
        )}
        <div className="gn-conn-f-ctrl">
          <Form.Item name="includeRedisDatabases" noStyle>
            <Select
              mode="multiple"
              style={{ width: "100%" }}
              placeholder={t(
                "connection.modal.field.displayRedisDatabases.placeholder",
              )}
              allowClear
            >
              {redisDbList.map((db: number) => (
                <Select.Option key={db} value={db}>
                  db{db}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </div>
      </div>
    )}

    {/* Mongo 认证机制 · 紧凑分段 */}
    {dbType === "mongodb" && (
      <div className="gn-conn-f-row" data-align="start">
        {denseLabel(
          t("connection.modal.dense.auth"),
          t("connection.modal.mongo.authMechanism.label"),
        )}
        <div className="gn-conn-f-ctrl">
          {renderChoiceCards({
            fieldName: "mongoAuthMechanism",
            value: String(mongoAuthMechanism),
            variant: "segment",
            options: [
              {
                value: "",
                label: t(
                  "connection.modal.mongo.authMechanism.auto.label",
                ),
                description: t(
                  "connection.modal.mongo.authMechanism.auto.description",
                ),
              },
              {
                value: "NONE",
                label: t(
                  "connection.modal.mongo.authMechanism.none.label",
                ),
                description: t(
                  "connection.modal.mongo.authMechanism.none.description",
                ),
              },
              {
                value: "SCRAM-SHA-1",
                label: "SCRAM-SHA-1",
                description: t(
                  "connection.modal.mongo.authMechanism.scramSha1.description",
                ),
              },
              {
                value: "SCRAM-SHA-256",
                label: "SCRAM-SHA-256",
                description: t(
                  "connection.modal.mongo.authMechanism.scramSha256.description",
                ),
              },
              {
                value: "MONGODB-AWS",
                label: "MONGODB-AWS",
                description: t(
                  "connection.modal.mongo.authMechanism.aws.description",
                ),
              },
            ],
          })}
        </div>
      </div>
    )}
  </>
);
