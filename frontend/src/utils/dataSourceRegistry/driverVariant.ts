import { getDataSourceSpec } from './index';
import { DATA_SOURCE_VARIANT_AUTO } from './types';

export type DriverVariantOption = {
  value: string;
  label: string;
  descriptionKey?: string;
  // 该档位实际启动的驱动代理键；独立构建档位与默认代理不同，需要单独安装。
  agentKey: string;
  separateAgent: boolean;
};

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/** 连接表单「驱动版本」下拉的选项：支持自动识别时首项为 auto，其后按服务端版本从旧到新。 */
export const buildDriverVariantOptions = (type: unknown): DriverVariantOption[] => {
  const spec = getDataSourceSpec(type);
  if (!spec) return [];
  const options: DriverVariantOption[] = [];
  if (spec.variants.auto) {
    options.push({
      value: DATA_SOURCE_VARIANT_AUTO,
      label: '',
      descriptionKey: 'connection_modal.field.driverVariant.autoDescription',
      agentKey: spec.type,
      separateAgent: false,
    });
  }
  for (const item of spec.variants.items) {
    options.push({
      value: item.id,
      label: item.label,
      descriptionKey: item.descriptionKey,
      agentKey: item.build?.key || spec.type,
      separateAgent: Boolean(item.build),
    });
  }
  return options;
};

/**
 * 归一连接上保存的档位值：描述表类型返回合法值（非法或为空时取描述的默认档位），
 * 其他类型返回 undefined，避免把档位字段带进历史类型的连接配置。
 */
export const normalizeDriverVariantValue = (type: unknown, value: unknown): string | undefined => {
  const spec = getDataSourceSpec(type);
  if (!spec) return undefined;
  const requested = normalize(value);
  if (requested === DATA_SOURCE_VARIANT_AUTO && spec.variants.auto) return requested;
  if (requested && spec.variants.items.some((item) => item.id === requested)) return requested;
  return spec.variants.default;
};

/** 连接要启动的驱动代理键，用于驱动状态查询与安装引导；非描述表类型返回原类型。 */
export const resolveRuntimeDriverKey = (type: unknown, variant: unknown): string => {
  const spec = getDataSourceSpec(type);
  if (!spec) return normalize(type);
  const selected = normalizeDriverVariantValue(type, variant);
  return spec.variants.items.find((item) => item.id === selected)?.build?.key || spec.type;
};
