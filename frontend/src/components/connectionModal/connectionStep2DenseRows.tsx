import { t } from "../../i18n";
import { Form, Select, Input } from "antd";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { DEFAULT_CONNECTION_ENVIRONMENT } from "../../utils/connectionEnvironment";
import ConnectionEnvironmentSelect from "../ConnectionEnvironmentSelect";
import type { ConnectionStep2UriBlockApi } from "./connectionStep2UriBlock";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface CreateConnectionStep2DenseRowsInput {
  isJVM: ConnectionModalStep2Props['isJVM'];
  denseLabel: ConnectionStep2UriBlockApi['denseLabel'];
}

export const createConnectionStep2DenseRows = ({ isJVM, denseLabel }: CreateConnectionStep2DenseRowsInput) => {
  /** 集群模式附加节点 · 扁平面板（Demo: .mode-extra .el/.eh + 全宽输入） */
  const renderClusterHostsExtra = ({
    fieldName,
    labelKey,
    helpKey,
    placeholderKey,
  }: {
    fieldName: string;
    labelKey: string;
    helpKey: string;
    placeholderKey: string;
  }) => (
    <div className="gn-conn-mode-extra">
      <div className="gn-conn-el">{t(labelKey)}</div>
      <div className="gn-conn-eh">{t(helpKey)}</div>
      <Form.Item name={fieldName} noStyle>
        <Select
          mode="tags"
          placeholder={t(placeholderKey)}
          tokenSeparators={[",", ";", " "]}
        />
      </Form.Item>
    </div>
  );

  const denseIdentityRows = (
    <div className="gn-conn-f-row">
      {denseLabel(
        t("connection.modal.dense.name"),
        t("connection.modal.field.name.label"),
      )}
      <div className="gn-conn-f-ctrl gn-conn-f-inline">
        <div className="gn-conn-w gn-conn-w-name">
          <Form.Item name="name" style={{ marginBottom: 0 }}>
            <Input
              {...noAutoCapInputProps}
              placeholder={
                isJVM
                  ? t("connection.modal.field.name.placeholder.jvm")
                  : t("connection.modal.field.name.placeholder.default")
              }
            />
          </Form.Item>
        </div>
        <div className="gn-conn-w gn-conn-w-env">
          <Form.Item
            name="environmentType"
            initialValue={DEFAULT_CONNECTION_ENVIRONMENT}
            style={{ marginBottom: 0 }}
          >
            <ConnectionEnvironmentSelect style={{ width: "100%" }} />
          </Form.Item>
        </div>
      </div>
    </div>
  );
  return { renderClusterHostsExtra, denseIdentityRows };
};

export type ConnectionStep2DenseRowsApi = ReturnType<typeof createConnectionStep2DenseRows>;
