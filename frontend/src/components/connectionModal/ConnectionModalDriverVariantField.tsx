import React, { useEffect, useMemo } from "react";
import { Form, Select, Tag, type FormInstance } from "antd";

import { t } from "../../i18n";
import {
  buildDriverVariantOptions,
  normalizeDriverVariantValue,
  type DriverVariantOption,
} from "../../utils/dataSourceRegistry/driverVariant";
import { DATA_SOURCE_VARIANT_AUTO } from "../../utils/dataSourceRegistry";
import "./ConnectionModalDriverVariantField.css";

export const DRIVER_VARIANT_FIELD = "driverVariant";

type ConnectionModalDriverVariantFieldProps = {
  dbType: string;
  // 由连接弹窗传入的表单实例（与其他 Step2 分区组件一致，不依赖 Form 上下文 hook）。
  form: Pick<FormInstance, "getFieldValue" | "setFieldsValue">;
  // 选择变化时清掉上一次测试连接的结果（档位不同，结论不再成立）。
  onChange?: () => void;
};

const optionTitle = (option: DriverVariantOption): string =>
  option.value === DATA_SOURCE_VARIANT_AUTO ? t("connection_modal.field.driverVariant.auto") : option.label;

const VariantOptionLabel: React.FC<{ option: DriverVariantOption }> = ({ option }) => (
  <div className="gn-conn-variant-option">
    <span className="gn-conn-variant-option__title">{optionTitle(option)}</span>
    {option.separateAgent ? (
      <Tag className="gn-conn-variant-option__tag">{t("connection_modal.field.driverVariant.separateAgent")}</Tag>
    ) : null}
    {option.descriptionKey ? (
      <span className="gn-conn-variant-option__description">{t(option.descriptionKey)}</span>
    ) : null}
  </div>
);

/**
 * 「驱动版本」字段：只对描述表数据源渲染。类型切换时把表单里的档位值纠正为该类型的合法值
 * （或清空），所以连接弹窗无需在选类型时额外重置这个字段。
 */
export const ConnectionModalDriverVariantField: React.FC<ConnectionModalDriverVariantFieldProps> = ({
  dbType,
  form,
  onChange,
}) => {
  const options = useMemo(() => buildDriverVariantOptions(dbType), [dbType]);

  useEffect(() => {
    const current = form.getFieldValue(DRIVER_VARIANT_FIELD);
    const normalized = normalizeDriverVariantValue(dbType, current);
    if (normalized !== current) {
      form.setFieldsValue({ [DRIVER_VARIANT_FIELD]: normalized });
    }
  }, [dbType, form]);

  if (options.length === 0) {
    return null;
  }
  return (
    <div className="gn-conn-f-row" data-align="start">
      <span className="gn-conn-f-label" title={t("connection_modal.field.driverVariant.label")}>
        {t("connection_modal.field.driverVariant.label")}
      </span>
      <div className="gn-conn-f-ctrl">
        <Form.Item name={DRIVER_VARIANT_FIELD} style={{ marginBottom: 0 }}>
          <Select
            className="gn-conn-variant-select"
            disabled={options.length === 1}
            optionLabelProp="title"
            options={options.map((option) => ({
              value: option.value,
              title: optionTitle(option),
              label: <VariantOptionLabel option={option} />,
            }))}
            onChange={() => onChange?.()}
          />
        </Form.Item>
        <div className="gn-conn-mode-hint">{t("connection_modal.field.driverVariant.help")}</div>
      </div>
    </div>
  );
};

export default ConnectionModalDriverVariantField;
