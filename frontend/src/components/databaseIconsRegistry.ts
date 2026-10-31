import { getDataSourceSpec, listDataSourceSpecs } from '../utils/dataSourceRegistry';
import hiveIconAsset from '../assets/db-icons/hive.svg';

// 描述表数据源的图标回落：图标文件统一放在 /db-icons/<type>.svg（官方 logo 或生成的字母徽标）。

export type RegistryIconConfig = {
    src: string;
    iconScale: number;
    color?: string;
};

// Bundle newly added icons so production never assumes an untracked public file.
const BUNDLED_REGISTRY_ICON_ASSETS: Record<string, string> = { hive: hiveIconAsset };

/** 描述表类型的图标资源；不是描述表类型时返回 undefined。 */
export const getRegistryIconConfig = (type: string): RegistryIconConfig | undefined => {
    const spec = getDataSourceSpec(type);
    if (!spec) return undefined;
    const icon = spec.ui?.icon;
    return {
        src: icon?.asset || BUNDLED_REGISTRY_ICON_ASSETS[spec.type] || `/db-icons/${spec.type}.svg`,
        iconScale: icon?.scale ?? (icon?.asset ? 0.72 : 0.82),
        color: icon?.color,
    };
};

/** 描述表类型的显示名。 */
export const getRegistryIconLabel = (type: string): string | undefined => getDataSourceSpec(type)?.displayName;

/** 图标选择器里追加的描述表类型。 */
export const listRegistryIconTypes = (): string[] => listDataSourceSpecs().map((spec) => spec.type);
