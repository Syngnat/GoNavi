import ConnectionModalKafkaAuth, { ConnectionModalKafkaCredentials } from "./ConnectionModalKafkaAuth";
import { t } from "../../i18n";
import { Form, Input, Select, Typography, Checkbox } from "antd";
import { PRIMARY_USERNAME_OPTIONAL_TYPES } from "../../utils/connectionTypeCapabilities";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { getStoredSecretPlaceholder } from "../../utils/connectionModalPresentation";
import type { ConnectionStep2UriBlockApi } from "./connectionStep2UriBlock";
import type { ConnectionStep2ProtectionApi } from "./connectionStep2Protection";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

const { Text } = Typography;

export interface ConnectionStep2AuthFieldsProps {
  isKafka: ConnectionModalStep2Props['isKafka'];
  setUseSSL: ConnectionModalStep2Props['setUseSSL'];
  setTestResult: ConnectionModalStep2Props['setTestResult'];
  setTestErrorLogOpen: ConnectionModalStep2Props['setTestErrorLogOpen'];
  setUriFeedback: ConnectionModalStep2Props['setUriFeedback'];
  isFileDb: ConnectionModalStep2Props['isFileDb'];
  isRedis: ConnectionModalStep2Props['isRedis'];
  denseLabel: ConnectionStep2UriBlockApi['denseLabel'];
  dbType: ConnectionModalStep2Props['dbType'];
  createUriAwareRequiredRule: ConnectionModalStep2Props['createUriAwareRequiredRule'];
  primaryPasswordVisible: ConnectionModalStep2Props['primaryPasswordVisible'];
  handlePrimaryPasswordVisibleChange: ConnectionModalStep2Props['handlePrimaryPasswordVisibleChange'];
  initialValues: ConnectionModalStep2Props['initialValues'];
  renderStoredSecretControls: ConnectionModalStep2Props['renderStoredSecretControls'];
  redisTopology: ConnectionModalStep2Props['redisTopology'];
  isPulsar: ConnectionModalStep2Props['isPulsar'];
  dbList: ConnectionModalStep2Props['dbList'];
  isNacosProtection: ConnectionStep2ProtectionApi['isNacosProtection'];
}

export const ConnectionStep2AuthFields = ({
  isKafka,
  setUseSSL,
  setTestResult,
  setTestErrorLogOpen,
  setUriFeedback,
  isFileDb,
  isRedis,
  denseLabel,
  dbType,
  createUriAwareRequiredRule,
  primaryPasswordVisible,
  handlePrimaryPasswordVisibleChange,
  initialValues,
  renderStoredSecretControls,
  redisTopology,
  isPulsar,
  dbList,
  isNacosProtection,
}: ConnectionStep2AuthFieldsProps) => (
  <>
    {/* 认证 · 密排（Demo：认证行 → 库范围 → 勾选 → 模式 → 生产保护） */}
    {isKafka && <ConnectionModalKafkaAuth onTLSChange={setUseSSL} onChange={() => { setTestResult(null); setTestErrorLogOpen(false); setUriFeedback(null); }} />}
    {!isFileDb && !isRedis && (
      <ConnectionModalKafkaCredentials kafka={isKafka}>
        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.auth"),
            t("connection.modal.field.username.label"),
          )}
          <div className="gn-conn-f-ctrl gn-conn-f-inline">
            <div className="gn-conn-w gn-conn-w-user">
              <Form.Item
                name="user"
                rules={
                  PRIMARY_USERNAME_OPTIONAL_TYPES.has(dbType)
                    ? []
                    : [
                        createUriAwareRequiredRule(
                          t("connection.modal.field.username.required"),
                        ),
                      ]
                }
                style={{ marginBottom: 0 }}
              >
                <Input
                  {...noAutoCapInputProps}
                  placeholder={
                    PRIMARY_USERNAME_OPTIONAL_TYPES.has(dbType)
                      ? t(
                          "connection.modal.field.username.optional_placeholder",
                        )
                      : t("connection.modal.field.username.label")
                  }
                />
              </Form.Item>
            </div>
            <div className="gn-conn-w gn-conn-w-pass">
              <Form.Item name="password" style={{ marginBottom: 0 }}>
                <Input.Password
                  {...noAutoCapInputProps}
                  visibilityToggle={{
                    visible: primaryPasswordVisible,
                    onVisibleChange: handlePrimaryPasswordVisibleChange,
                  }}
                  placeholder={getStoredSecretPlaceholder({
                    hasStoredSecret: initialValues?.hasPrimaryPassword,
                    emptyPlaceholder: t(
                      "connection.modal.field.password.placeholder",
                    ),
                    retainedLabel: t(
                      "connection.modal.field.password.retained",
                    ),
                  })}
                />
              </Form.Item>
            </div>
          </div>
        </div>
        {initialValues?.hasPrimaryPassword
          ? renderStoredSecretControls({
              fieldName: "password",
              clearKey: "primaryPassword",
              hasStoredSecret: initialValues?.hasPrimaryPassword,
              clearLabel: t(
                "connection.modal.secret.clear_saved_password",
              ),
              description: t("connection.modal.secret.saved_password"),
            })
          : null}
      </ConnectionModalKafkaCredentials>
    )}

    {isRedis && (
      <>
        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.auth"),
            t("connection.modal.field.username.label"),
          )}
          <div className="gn-conn-f-ctrl gn-conn-f-inline">
            <div className="gn-conn-w gn-conn-w-user">
              <Form.Item name="user" style={{ marginBottom: 0 }}>
                <Input
                  {...noAutoCapInputProps}
                  placeholder={t(
                    "connection.modal.field.username.optional_placeholder",
                  )}
                />
              </Form.Item>
            </div>
            <div className="gn-conn-w gn-conn-w-pass">
              <Form.Item name="password" style={{ marginBottom: 0 }}>
                <Input.Password
                  {...noAutoCapInputProps}
                  visibilityToggle={{
                    visible: primaryPasswordVisible,
                    onVisibleChange: handlePrimaryPasswordVisibleChange,
                  }}
                  placeholder={getStoredSecretPlaceholder({
                    hasStoredSecret: initialValues?.hasPrimaryPassword,
                    emptyPlaceholder: t(
                      "connection.modal.field.redisPassword.placeholder",
                    ),
                    retainedLabel: t(
                      "connection.modal.field.redisPassword.retained",
                    ),
                  })}
                />
              </Form.Item>
            </div>
          </div>
        </div>
        {initialValues?.hasPrimaryPassword
          ? renderStoredSecretControls({
              fieldName: "password",
              clearKey: "primaryPassword",
              hasStoredSecret: initialValues?.hasPrimaryPassword,
              clearLabel: t(
                "connection.modal.secret.clear_saved_password",
              ),
              description: t(
                "connection.modal.secret.saved_redis_password",
              ),
            })
          : null}
      </>
    )}

    {isRedis && redisTopology === "sentinel" && (
      <>
        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.auth"),
            t("connection.modal.redis.credentials.sentinelUser.label"),
          )}
          <div className="gn-conn-f-ctrl gn-conn-f-inline">
            <div className="gn-conn-w gn-conn-w-user">
              <Form.Item
                name="redisSentinelUser"
                style={{ marginBottom: 0 }}
              >
                <Input
                  {...noAutoCapInputProps}
                  placeholder={t(
                    "connection.modal.redis.credentials.sentinelUser.placeholder",
                  )}
                />
              </Form.Item>
            </div>
            <div className="gn-conn-w gn-conn-w-pass">
              <Form.Item
                name="redisSentinelPassword"
                style={{ marginBottom: 0 }}
              >
                <Input.Password
                  {...noAutoCapInputProps}
                  placeholder={getStoredSecretPlaceholder({
                    hasStoredSecret:
                      initialValues?.hasRedisSentinelPassword,
                    emptyPlaceholder: t(
                      "connection.modal.redis.credentials.sentinelPassword.placeholder.empty",
                    ),
                    retainedLabel: t(
                      "connection.modal.redis.credentials.sentinelPassword.placeholder.retained",
                    ),
                  })}
                />
              </Form.Item>
            </div>
          </div>
        </div>
        {initialValues?.hasRedisSentinelPassword
          ? renderStoredSecretControls({
              fieldName: "redisSentinelPassword",
              clearKey: "redisSentinelPassword",
              hasStoredSecret: initialValues?.hasRedisSentinelPassword,
              clearLabel: t(
                "connection.modal.redis.credentials.sentinelPassword.clear",
              ),
              description: t(
                "connection.modal.redis.credentials.sentinelPassword.description",
              ),
            })
          : null}
      </>
    )}

    {/* 固定库范围保留精确匹配语义，避免历史下划线库名被通配符规则放宽。 */}
    {!isFileDb && !isRedis && !isKafka && !isPulsar && (
      <>
        <div className="gn-conn-f-row">
          {denseLabel(
            t("connection.modal.dense.scopeExact"),
            t("connection.modal.field.displayDatabases.help"),
          )}
          <div className="gn-conn-f-ctrl">
            <Form.Item name="includeDatabases" noStyle>
              <Select
                className="gn-conn-scope-select"
                mode="tags"
                style={{ width: "100%", minWidth: "100%" }}
                popupMatchSelectWidth
                tokenSeparators={[",", ";", " "]}
                placeholder={t(
                  "connection.modal.dense.scopePlaceholder",
                )}
                allowClear
                maxTagCount="responsive"
                options={dbList.map((db: string) => ({
                  value: db,
                  label: db,
                }))}
              />
            </Form.Item>
          </div>
        </div>

        {!isNacosProtection && (
          <>
            <div className="gn-conn-f-row">
              {denseLabel(
                t("connection.modal.dense.scopeIncludePattern"),
                t("connection.modal.field.includeDatabasePatterns.help"),
              )}
              <div className="gn-conn-f-ctrl">
                <Form.Item name="includeDatabasePatterns" noStyle>
                  <Select
                    className="gn-conn-scope-select"
                    mode="tags"
                    style={{ width: "100%", minWidth: "100%" }}
                    tokenSeparators={[",", ";"]}
                    placeholder={t(
                      "connection.modal.field.includeDatabasePatterns.placeholder",
                    )}
                    allowClear
                    maxTagCount="responsive"
                  />
                </Form.Item>
              </div>
            </div>

            <div className="gn-conn-f-row" data-align="start">
              {denseLabel(
                t("connection.modal.dense.scopeExcludePattern"),
                t("connection.modal.field.excludeDatabasePatterns.help"),
              )}
              <div className="gn-conn-f-ctrl">
                <Form.Item name="excludeDatabasePatterns" noStyle>
                  <Select
                    className="gn-conn-scope-select"
                    mode="tags"
                    style={{ width: "100%", minWidth: "100%" }}
                    tokenSeparators={[",", ";"]}
                    placeholder={t(
                      "connection.modal.field.excludeDatabasePatterns.placeholder",
                    )}
                    allowClear
                    maxTagCount="responsive"
                  />
                </Form.Item>
                <Text type="secondary" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
                  {t("connection.modal.field.databasePatterns.help")}
                </Text>
              </div>
            </div>
          </>
        )}
      </>
    )}

    {/* demo .check-line：保存密码 + 保存后连接并展开（后者 UI 对齐；连接/展开由 onSaved 侧既有流程处理时可再接线） */}
    {!isFileDb && (
      <div className="gn-conn-check-line">
        <Form.Item
          name="savePassword"
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Checkbox>
            {t("connection.modal.field.savePassword")}
          </Checkbox>
        </Form.Item>
        <Form.Item
          name="connectAndExpandAfterSave"
          valuePropName="checked"
          initialValue={true}
          style={{ marginBottom: 0 }}
        >
          <Checkbox>
            {t("connection.modal.dense.connectAndExpand")}
          </Checkbox>
        </Form.Item>
      </div>
    )}
  </>
);
