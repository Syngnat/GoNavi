import { message } from 'antd';

import { t } from '../../i18n';
import { isBackendCancelledResult } from '../../utils/connectionExport';
import { ExportDriverPackage, InspectDriverPackage } from '../../../wailsjs/go/app/App';

// 驱动包（ZIP）导出 / 批量导入的编排与分组策略。
//
// 后端只提供「导出打包」与「只读解析」两个方法；批量安装仍走已有的
// InstallLocalDriverPackage 逐驱动串行循环（Go 侧安装锁不可重入，不能在那里套批量）。

/** 后端 ExportDriverPackage 的返回 Data。 */
export type DriverPackageExportSummary = {
  path: string;
  driverCount: number;
  skipped: string[];
  totalBytes: number;
};

/** 后端 InspectDriverPackage 返回的单个驱动。 */
export type DriverPackageInspectItem = {
  driverType: string;
  driverName: string;
  version?: string;
  entry: string;
  goos?: string;
  goarch?: string;
  installed: boolean;
  installedVersion?: string;
  revisionMismatch?: boolean;
  packageRevision?: string;
  expectedRevision?: string;
  platformMismatch?: boolean;
};

export type DriverPackageInspectSummary = {
  path: string;
  manifestPresent: boolean;
  drivers: DriverPackageInspectItem[];
};

export type DriverPackageImportPlan = {
  /** 可安装：未安装，或已安装且启用覆盖。 */
  installable: DriverPackageInspectItem[];
  /** 已安装且未启用覆盖，跳过。 */
  skipped: DriverPackageInspectItem[];
  /** 不可安装：revision 或平台不匹配，即使启用覆盖也不装。 */
  blocked: DriverPackageInspectItem[];
};

/** 后端 driver:package-export-progress 事件的负载。 */
export type DriverPackageExportProgressEvent = {
  jobId: string;
  /** start | running | done | canceled | error */
  status: string;
  written: number;
  total: number;
  currentDriver?: string;
  message?: string;
};

/** 导出进度在 UI 上的呈现态。 */
export type DriverPackageExportProgressState = {
  status: DriverPackageExportProgressEvent['status'];
  written: number;
  total: number;
  currentDriver: string;
  message: string;
};

const normalizeByteCount = (value: unknown): number => {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) {
    return 0;
  }
  return Math.trunc(next);
};

/**
 * 把后端进度事件归一到 UI 状态。jobId 不匹配（陈旧事件、并行导出）返回 null。
 *
 * 归一化而非直接透传，是因为 total 可能为 0（极小的驱动包或事件早于统计完成），
 * 此时百分比无意义，交由展示层显示为「进行中」。
 */
export const normalizeDriverPackageExportProgress = (
  event: unknown,
  expectedJobId: string,
): DriverPackageExportProgressState | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const typed = event as Record<string, unknown>;
  const jobId = String(typed.jobId || '').trim();
  if (!jobId || jobId !== String(expectedJobId || '').trim()) {
    return null;
  }
  return {
    status: String(typed.status || '').trim(),
    written: normalizeByteCount(typed.written),
    total: normalizeByteCount(typed.total),
    currentDriver: String(typed.currentDriver || '').trim(),
    message: String(typed.message || '').trim(),
  };
};

/** 导出进度百分比；分母缺失或为 0 时返回 0（进度不可知，不当成已完成）。 */
export const computeDriverPackageExportPercent = (
  written: number,
  total: number,
): number => {
  const safeTotal = normalizeByteCount(total);
  if (safeTotal <= 0) {
    return 0;
  }
  const safeWritten = Math.max(0, normalizeByteCount(written));
  return Math.min(100, (safeWritten / safeTotal) * 100);
};

/** 人类可读的字节数，用于进度条下的「已写入 x / y」。 */
export const formatDriverPackageBytes = (value: number): string => {
  const bytes = Math.max(0, normalizeByteCount(value));
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  // 保留一位小数，但整数不显示 .0（15.9 MB 有意义，16.0 MB 不如 16 MB 干净）。
  const rounded = Math.round(size * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${units[unitIndex]}`;
};

/** 生成一次导出的任务 id，用于订阅进度与请求取消。 */
export const buildDriverPackageExportJobId = (): string => (
  `driver-package-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
);

/**
 * 判定「运行期取消」—— 即用户点了进度条上的取消按钮，而非在保存对话框里点取消。
 *
 * 两者语义不同：前者是一次真实发生又被中止的写盘，值得回一句「已取消导出」；
 * 后者任务压根没启动，弹提示只是噪音（沿用既有约定：用户主动取消不报错）。
 * 因此这里只认结构化标记 data.canceled，不依赖任何语言的文案字面量。
 */
export const isDriverPackageExportRunCanceled = (result: unknown): boolean => {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const typed = result as { success?: unknown; data?: unknown };
  if (typed.success === true) {
    return false;
  }
  const data = typed.data;
  return Boolean(data) && typeof data === 'object'
    && (data as Record<string, unknown>).canceled === true;
};

/** 判定「导出未完成」，运行期取消与保存对话框取消都算。 */
export const isDriverPackageExportCanceled = (result: unknown): boolean => (
  isDriverPackageExportRunCanceled(result) || isBackendCancelledResult(result)
);

type DriverPackageQueryResult = {
  success?: boolean;
  message?: string;
  data?: unknown;
};

type DriverPackageExportSelection = (
  downloadDir: string,
  jobId: string,
  driverTypes: string[],
) => Promise<DriverPackageQueryResult>;

type DriverPackageZipPicker = (currentPath: string) => Promise<DriverPackageQueryResult>;

type WailsDriverPackageApp = {
  ExportDriverPackageSelection?: DriverPackageExportSelection;
  SelectDriverPackageZipFile?: DriverPackageZipPicker;
};

const wailsDriverPackageApp = (): WailsDriverPackageApp | undefined => {
  const runtime = window as Window & {
    go?: { app?: { App?: WailsDriverPackageApp } };
  };
  return runtime.go?.app?.App;
};

export const selectDriverPackageZipFile = (downloadDir: string): Promise<DriverPackageQueryResult> => {
  const selectZip = wailsDriverPackageApp()?.SelectDriverPackageZipFile;
  if (!selectZip) {
    return Promise.reject(new Error('SelectDriverPackageZipFile unavailable'));
  }
  return selectZip(downloadDir);
};

const invokeExportDriverPackage = (
  downloadDir: string,
  jobId: string,
  driverTypes: string[],
): Promise<DriverPackageQueryResult> => {
  const selected = driverTypes.map((driverType) => driverType.trim()).filter(Boolean);
  if (selected.length === 0) {
    return ExportDriverPackage(downloadDir, jobId);
  }
  const exportSelection = wailsDriverPackageApp()?.ExportDriverPackageSelection;
  if (!exportSelection) {
    return Promise.reject(new Error('ExportDriverPackageSelection unavailable'));
  }
  return exportSelection(downloadDir, jobId, selected);
};

/**
 * 导出已安装的可选驱动。driverTypes 为空时导出全部。
 * 返回 null 表示用户取消（不弹错误提示）。
 *
 * jobId 由调用方生成并透传：前端据此订阅 driver:package-export-progress 进度事件
 * 并调用 CancelExportFile 请求取消。
 */
export const exportDriverPackage = async (
  downloadDir: string,
  jobId: string,
  driverTypes: string[] = [],
): Promise<DriverPackageExportSummary | null> => {
  try {
    const result = await invokeExportDriverPackage(downloadDir, jobId, driverTypes);
    if (!result?.success) {
      if (isDriverPackageExportCanceled(result)) {
        // 只有运行期取消才回执：进度条已经消失，不给一句反馈用户同样不知道
        // 到底导出成功了没有 —— 这正是本次要消除的疑问。
        if (isDriverPackageExportRunCanceled(result)) {
          message.info(t('driver_manager.export.canceled'));
        }
        return null;
      }
      message.error(String(result?.message || '').trim() || t('driver_manager.export.failed'));
      return null;
    }
    const data = (result.data || {}) as Record<string, unknown>;
    const summary: DriverPackageExportSummary = {
      path: String(data.path || '').trim(),
      driverCount: Number(data.driverCount || 0),
      skipped: Array.isArray(data.skipped) ? (data.skipped as string[]) : [],
      totalBytes: Number(data.totalBytes || 0),
    };
    message.success(t('driver_manager.export.success', {
      count: summary.driverCount,
      path: summary.path,
    }));
    return summary;
  } catch (error) {
    const errText = error instanceof Error ? error.message : String(error || '');
    message.error(t('driver_manager.export.failed_detail', { detail: errText }));
    return null;
  }
};

/** 解析驱动包内容；失败时返回 null 并已提示。 */
export const inspectDriverPackage = async (
  zipPath: string,
  downloadDir: string,
): Promise<DriverPackageInspectSummary | null> => {
  try {
    const result = await InspectDriverPackage(zipPath, downloadDir);
    if (!result?.success) {
      if (!isBackendCancelledResult(result)) {
        message.error(String(result?.message || '').trim() || t('driver_manager.import.inspect_failed', { detail: '' }));
      }
      return null;
    }
    const data = (result.data || {}) as Record<string, unknown>;
    const rawDrivers = Array.isArray(data.drivers) ? data.drivers : [];
    return {
      path: String(data.path || zipPath).trim(),
      manifestPresent: data.manifestPresent === true,
      drivers: rawDrivers as DriverPackageInspectItem[],
    };
  } catch (error) {
    const errText = error instanceof Error ? error.message : String(error || '');
    message.error(t('driver_manager.import.inspect_failed', { detail: errText }));
    return null;
  }
};

/**
 * 把解析结果分成可安装 / 跳过 / 不可安装三组。
 *
 * 优先级：平台不匹配 > revision 不匹配 > 已安装去重。
 * 前两者即使启用「覆盖已安装驱动」也不可安装 —— 安装必然失败（后端 revision 校验
 * 不放松），提前拦下比让用户等到安装报错更好。
 */
export const planDriverPackageImport = (
  items: readonly DriverPackageInspectItem[],
  options: { forceOverwrite?: boolean } = {},
): DriverPackageImportPlan => {
  const forceOverwrite = options.forceOverwrite === true;
  const installable: DriverPackageInspectItem[] = [];
  const skipped: DriverPackageInspectItem[] = [];
  const blocked: DriverPackageInspectItem[] = [];

  for (const item of items) {
    if (item.platformMismatch || item.revisionMismatch) {
      blocked.push(item);
      continue;
    }
    if (item.installed && !forceOverwrite) {
      skipped.push(item);
      continue;
    }
    installable.push(item);
  }
  return { installable, skipped, blocked };
};

/** 单个驱动在导入确认表里的状态码。 */
export type DriverPackageImportStatus =
  | 'install'
  | 'skip_installed'
  | 'overwrite'
  | 'revision_mismatch'
  | 'platform_mismatch';

export const resolveDriverPackageImportStatus = (
  item: DriverPackageInspectItem,
  options: { forceOverwrite?: boolean } = {},
): DriverPackageImportStatus => {
  if (item.platformMismatch) return 'platform_mismatch';
  if (item.revisionMismatch) return 'revision_mismatch';
  if (item.installed) return options.forceOverwrite === true ? 'overwrite' : 'skip_installed';
  return 'install';
};

export type DriverPackageImportOutcome = {
  success: number;
  failed: number;
  skipped: number;
  blocked: number;
  /**
   * 用户中途取消。取消不是失败 —— 已装的如实报数，剩下的报「未安装」，
   * 落到失败分支会让用户以为出了错。未装完的项不计入 failed。
   */
  canceled?: boolean;
};

/**
 * 汇总导入结果并给出对应的提示文案 key 与参数。
 * 返回的 key 需由调用方用 t() 解析（保持本模块不直接弹 toast，便于单测）。
 */
export const summarizeDriverPackageImport = (outcome: DriverPackageImportOutcome) => {
  const { success, failed, skipped, blocked } = outcome;
  // 取消优先于其它分支：哪怕中途也失败过，用户的主诉求是「我按了取消」。
  if (outcome.canceled) {
    return {
      level: 'info' as const,
      key: 'driver_manager.import.summary.canceled',
      params: { success, skip: skipped },
    };
  }
  if (success === 0 && failed === 0) {
    // 一个都没装：要么全被拦下，要么全已安装跳过。
    if (blocked > 0) {
      return { level: 'error' as const, key: 'driver_manager.import.blocked_all', params: { blocked } };
    }
    return { level: 'info' as const, key: 'driver_manager.import.summary.skipped_all', params: { skip: skipped } };
  }
  if (failed === 0) {
    return { level: 'success' as const, key: 'driver_manager.import.summary.success', params: { success, skip: skipped } };
  }
  if (success > 0) {
    return {
      level: 'warning' as const,
      key: 'driver_manager.import.summary.partial',
      params: { success, failed, skip: skipped },
    };
  }
  return { level: 'error' as const, key: 'driver_manager.import.summary.failed', params: { failed } };
};
