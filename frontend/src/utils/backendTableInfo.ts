/**
 * DBGetTableInfo 的前端桥接层。
 *
 * 该绑定是 Navicat 布局改造新增的 Wails 方法；与 loadAboutInfo 一致走
 * window.go 动态调用，不依赖 wailsjs 生成物（生成物更新前后均可运行），
 * 返回值在这里收敛为本地类型。
 */

export interface TableInfoDetails {
  engine?: string;
  comment?: string;
  collation?: string;
  rowFormat?: string;
  rows?: number;
  dataLength?: number;
  indexLength?: number;
  autoIncrement?: string;
  createTime?: string;
  updateTime?: string;
}

export interface TableInfoResult {
  /** 后端是否成功执行；不支持方言时为 true 且 details 为空。 */
  success: boolean;
  message?: string;
  /** null = 当前数据源不支持表信息查询（前端降级展示 DDL 等已有信息）。 */
  details: TableInfoDetails | null;
}

interface RawQueryResultLike {
  success?: boolean;
  message?: string;
  data?: unknown;
}

export const isTableInfoAvailable = (): boolean => {
  const backendApp = (window as any)?.go?.app?.App;
  return typeof backendApp?.DBGetTableInfo === 'function';
};

export const fetchTableInfo = async (
  rpcConfig: unknown,
  dbName: string,
  schemaName: string | undefined,
  tableName: string,
): Promise<TableInfoResult> => {
  const backendApp = (window as any)?.go?.app?.App;
  if (typeof backendApp?.DBGetTableInfo !== 'function') {
    return { success: false, details: null, message: 'DBGetTableInfo unavailable' };
  }
  try {
    const res = (await backendApp.DBGetTableInfo(rpcConfig, dbName, schemaName || '', tableName)) as RawQueryResultLike;
    if (!res?.success) {
      return { success: false, details: null, message: String(res?.message || '') };
    }
    const details = (res.data && typeof res.data === 'object')
      ? normalizeTableInfoDetails(res.data as Record<string, unknown>)
      : null;
    return { success: true, details };
  } catch (e: any) {
    return { success: false, details: null, message: e?.message || String(e) };
  }
};

const toOptionalString = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
};

const toOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
};

export const normalizeTableInfoDetails = (raw: Record<string, unknown>): TableInfoDetails => ({
  engine: toOptionalString(raw.engine),
  comment: toOptionalString(raw.comment),
  collation: toOptionalString(raw.collation),
  rowFormat: toOptionalString(raw.rowFormat),
  rows: toOptionalNumber(raw.rows),
  dataLength: toOptionalNumber(raw.dataLength),
  indexLength: toOptionalNumber(raw.indexLength),
  autoIncrement: toOptionalString(raw.autoIncrement),
  createTime: toOptionalString(raw.createTime),
  updateTime: toOptionalString(raw.updateTime),
});
