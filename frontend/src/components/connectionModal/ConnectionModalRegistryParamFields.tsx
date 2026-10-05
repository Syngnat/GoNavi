import React from "react";
import { Form, Input } from "antd";

import { t } from "../../i18n";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { getDataSourceSpec } from "../../utils/dataSourceRegistry";
import { normalizeConnectionParamsText } from "./connectionModalUri";

/** 读出连接参数文本里的某个键（不存在时为空串）。 */
export const readRegistryParam = (connectionParams: unknown, key: string): string =>
  new URLSearchParams(normalizeConnectionParamsText(connectionParams)).get(key) ?? "";

/** 写回连接参数文本里的某个键；值为空时删除该键，其他参数原样保留。 */
export const writeRegistryParam = (connectionParams: unknown, key: string, value: string): string => {
  const params = new URLSearchParams(normalizeConnectionParamsText(connectionParams));
  if (value.trim() === "") {
    params.delete(key);
  } else {
    params.set(key, value);
  }
  return params.toString();
};

type ConnectionModalRegistryParamFieldsProps = {
  dbType: string;
  onChange?: () => void;
};

/**
 * 描述表声明的专用连接参数字段（ui.paramFields，如 GBase 8s 的 CSDK 目录）：值直接读写在「连接参数」文本里，
 * 保存与连接串生成沿用现有链路。
 */
export const ConnectionModalRegistryParamFields: React.FC<ConnectionModalRegistryParamFieldsProps> = ({ dbType, onChange }) => {
  const fields = getDataSourceSpec(dbType)?.ui?.paramFields ?? [];
  if (fields.length === 0) {
    return null;
  }
  return (
    <Form.Item noStyle shouldUpdate={(previous, next) => previous.connectionParams !== next.connectionParams}>
      {(form) => fields.map((field) => {
        const id = `registry-param-${field.key}`;
        return (
          <div className="gn-conn-f-row" data-align="start" key={field.key}>
            <label className="gn-conn-f-label" htmlFor={id} title={t(field.labelKey)}>{t(field.labelKey)}</label>
            <div className="gn-conn-f-ctrl">
              <Input
                id={id}
                {...noAutoCapInputProps}
                value={readRegistryParam(form.getFieldValue("connectionParams"), field.key)}
                placeholder={field.placeholder}
                onChange={(event) => {
                  form.setFieldValue("connectionParams", writeRegistryParam(form.getFieldValue("connectionParams"), field.key, event.target.value));
                  onChange?.();
                }}
              />
              {field.helpKey ? <div className="gn-conn-mode-hint">{t(field.helpKey)}</div> : null}
            </div>
          </div>
        );
      })}
    </Form.Item>
  );
};

export default ConnectionModalRegistryParamFields;
