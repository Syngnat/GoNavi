import type { DataSyncTaskDefinition } from './model';

export type DataSyncTaskPatch = Partial<
  Omit<
    DataSyncTaskDefinition,
    'id' | 'schemaVersion' | 'revision' | 'editEpoch' | 'createdAt'
  >
>;

export type DataSyncTaskPatchUpdater =
  | DataSyncTaskPatch
  | ((currentTask: DataSyncTaskDefinition) => DataSyncTaskPatch);

const normalizedJSON = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map((item) => normalizedJSON(item)).join(',')}]`;
  }
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${normalizedJSON(record[key])}`)
    .join(',')}}`;
};

/**
 * 自动修复和后台元数据探测可能回传内容完全相同的补丁。这类补丁不应推进
 * editEpoch、标脏任务或清空仍在倒计时的审批 challenge。
 */
export const dataSyncTaskPatchHasChanges = (
  task: DataSyncTaskDefinition,
  patch: DataSyncTaskPatch,
): boolean => {
  const current = task as unknown as Record<string, unknown>;
  return Object.entries(patch).some(
    ([key, value]) => normalizedJSON(current[key]) !== normalizedJSON(value),
  );
};
