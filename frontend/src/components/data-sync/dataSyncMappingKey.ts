/**
 * 数据同步映射的稳定标识。
 *
 * 预检问题回传的 `mappingId` 必须能定位到具体映射行，所以双方共用同一套算法：
 * 后端 `dataSyncJobMappingKey()` 与这里的 `dataSyncMappingKey()` 必须逐字一致。
 *
 * 不用映射行的 `id`（`${taskId}:mapping:${idStem}`）：那个 id 由前端生成、含任务
 * 与生成序号，后端算不出来；也不用后端原有的展示串 `A.T -> B.T` 之外的任何东西，
 * 因为展示串会随文案调整而变，不是契约。
 *
 * 规则：源/目标各自按「schema 优先、缺失时回落到任务级 schema」补齐，再统一
 * 小写去空白，最后用 " -> " 连接。
 */

export const qualifiedObject = (schema: string, name: string): string =>
  schema.trim() ? `${schema.trim()}.${name.trim()}` : name.trim();

export const splitQualifiedObject = (
  value: string,
  fallbackSchema: string,
): { schema: string; name: string } => {
  const normalized = value.trim();
  const separator = normalized.lastIndexOf('.');
  if (separator <= 0 || separator === normalized.length - 1) {
    return { schema: fallbackSchema.trim(), name: normalized };
  }
  return {
    schema: normalized.slice(0, separator).trim(),
    name: normalized.slice(separator + 1).trim(),
  };
};

const normalizeKeyPart = (value: string): string => value.trim().toLowerCase();

const keyPartFor = (object: string, fallbackSchema: string): string => {
  const { schema, name } = splitQualifiedObject(object, fallbackSchema);
  return normalizeKeyPart(qualifiedObject(schema, name));
};

/**
 * 计算映射的稳定键。`sourceSchema`/`targetSchema` 传任务级 schema，
 * 与写回后端的 wire 形状保持同一回落规则。
 */
export const dataSyncMappingKey = (
  mapping: { sourceObject: string; targetObject: string },
  sourceSchema: string,
  targetSchema: string,
): string =>
  `${keyPartFor(mapping.sourceObject, sourceSchema)} -> ${keyPartFor(
    mapping.targetObject,
    targetSchema,
  )}`;
