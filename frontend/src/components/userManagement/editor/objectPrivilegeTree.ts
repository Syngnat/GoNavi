import type { UMGrant } from '../userManagementTypes';

/**
 * 对象树布局：
 * - database：库 → 表 → 列（MySQL / ClickHouse / TDengine）
 * - database-schema：当前库 → 模式 → 表 → 列（PG 系 / SQL Server，授权按库存放）
 * - schema：模式（用户）→ 表 → 列（Oracle / 达梦）
 */
export type ObjectTreeLayout = 'database' | 'database-schema' | 'schema';

export const resolveObjectTreeLayout = (family: string): ObjectTreeLayout => {
  switch (family) {
    case 'postgres':
    case 'opengauss':
    case 'sqlserver':
      return 'database-schema';
    case 'oracle':
    case 'dameng':
      return 'schema';
    default:
      return 'database';
  }
};

/** 拆分 schema.table；未限定时 schema 为空。 */
export const splitQualifiedTable = (name: string): { schema: string; table: string } => {
  const index = name.indexOf('.');
  if (index <= 0) return { schema: '', table: name };
  return { schema: name.slice(0, index), table: name.slice(index + 1) };
};

const TARGET_FIELDS = ['scope', 'database', 'schema', 'object', 'column', 'objectType'] as const;

/** 授权目标（不含权限名）的稳定键。 */
export const targetKey = (target: UMGrant): string => JSON.stringify(TARGET_FIELDS.map((field) => String(target[field] || '')));

export const targetFromKey = (key: string): UMGrant => {
  const values = JSON.parse(key) as string[];
  const target: UMGrant = { privilege: '', scope: values[0] };
  TARGET_FIELDS.slice(1).forEach((field, index) => {
    if (values[index + 1]) target[field] = values[index + 1];
  });
  return target;
};

/** 目标的可读路径，如 sales.public.orders.amount。 */
export const describeTarget = (target: UMGrant): string => (
  [target.database, target.schema, target.object, target.column].filter(Boolean).join('.')
  || (target.objectType ? `${target.objectType}` : '*')
);

/** 草稿中已有授权的非全局目标（去重，保持首次出现顺序）。 */
export const grantedTargets = (grants: UMGrant[]): UMGrant[] => {
  const seen = new Set<string>();
  const targets: UMGrant[] = [];
  grants.forEach((grant) => {
    if (grant.scope === 'global') return;
    const target: UMGrant = { ...grant, privilege: '', withGrantOption: undefined, deny: undefined, inherited: undefined };
    const key = targetKey(target);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(targetFromKey(key));
  });
  return targets;
};

export const tableTarget = (layout: ObjectTreeLayout, database: string, qualified: string): UMGrant => {
  const { schema, table } = splitQualifiedTable(qualified);
  if (layout === 'schema') return { privilege: '', scope: 'table', schema: database, object: qualified.includes('.') ? table : qualified };
  const target: UMGrant = { privilege: '', scope: 'table', database, object: table };
  if (schema) target.schema = schema;
  return target;
};

export interface ManualTargetInput {
  scope: string;
  /** 库（database / database-schema 布局）或模式属主（schema 布局）。 */
  container: string;
  /** 对象名；database-schema 布局下可写成 schema.object，schema 授权时为模式名。 */
  object: string;
  objectType?: string;
}

/** 该授权层级是否还需要填写对象名（库级 / Oracle 系模式级只有容器）。 */
export const manualTargetNeedsObject = (layout: ObjectTreeLayout, scope: string): boolean => (
  scope === 'database' ? false : !(layout === 'schema' && scope === 'schema')
);

/** 由手动选择的层级 / 容器 / 对象组装授权目标；信息不全返回 null。 */
export const buildManualTarget = (layout: ObjectTreeLayout, input: ManualTargetInput): UMGrant | null => {
  const container = input.container.trim();
  const object = input.object.trim();
  if (!container) return null;
  const base: UMGrant = { privilege: '', scope: input.scope };
  if (layout === 'schema') {
    if (input.scope === 'schema') return { ...base, schema: container };
    if (!object) return null;
    return { ...base, schema: container, object, ...(input.objectType ? { objectType: input.objectType } : {}) };
  }
  if (input.scope === 'database') return { ...base, database: container };
  if (!object) return null;
  if (input.scope === 'schema') return { ...base, database: container, schema: object };
  const { schema, table } = layout === 'database-schema' ? splitQualifiedTable(object) : { schema: '', table: object };
  return {
    ...base,
    database: container,
    ...(schema ? { schema, object: table } : { object }),
    ...(input.objectType ? { objectType: input.objectType } : {}),
  };
};

/** 树里除表以外可授权的对象：视图、序列、函数 / 存储过程。 */
export interface CatalogObject {
  kind: 'view' | 'sequence' | 'routine';
  /** 所属模式；database / schema 布局下为空（容器本身就是归属）。 */
  schema: string;
  name: string;
  objectType?: 'FUNCTION' | 'PROCEDURE';
}

/** 某个容器（库 / 模式）节点下应展示的非表对象。 */
export const catalogObjectsFor = (layout: ObjectTreeLayout, objects: CatalogObject[], schema: string): CatalogObject[] => (
  layout === 'database-schema' ? objects.filter((item) => item.schema === schema) : objects
);

export const catalogObjectTarget = (layout: ObjectTreeLayout, container: string, item: CatalogObject): UMGrant => {
  if (item.kind === 'view') return tableTarget(layout, container, item.schema ? `${item.schema}.${item.name}` : item.name);
  const base: UMGrant = { privilege: '', scope: item.kind };
  if (layout === 'schema') return { ...base, schema: container, object: item.name, ...(item.objectType ? { objectType: item.objectType } : {}) };
  return {
    ...base,
    database: container,
    ...(item.schema && layout === 'database-schema' ? { schema: item.schema } : {}),
    object: item.name,
    ...(item.objectType ? { objectType: item.objectType } : {}),
  };
};
