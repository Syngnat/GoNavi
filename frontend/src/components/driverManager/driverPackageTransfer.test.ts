import { describe, expect, it } from 'vitest';

import {
  buildDriverPackageExportJobId,
  computeDriverPackageExportPercent,
  formatDriverPackageBytes,
  isDriverPackageExportCanceled,
  isDriverPackageExportRunCanceled,
  normalizeDriverPackageExportProgress,
  planDriverPackageImport,
  resolveDriverPackageImportStatus,
  summarizeDriverPackageImport,
  type DriverPackageInspectItem,
} from './driverPackageTransfer';

const buildItem = (overrides: Partial<DriverPackageInspectItem> = {}): DriverPackageInspectItem => ({
  driverType: 'mariadb',
  driverName: 'MariaDB',
  entry: 'MacOS/mariadb-driver-agent-darwin-arm64',
  installed: false,
  ...overrides,
});

describe('planDriverPackageImport', () => {
  it('routes uninstalled drivers to installable', () => {
    const plan = planDriverPackageImport([buildItem()]);
    expect(plan.installable).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.blocked).toHaveLength(0);
  });

  it('skips already installed drivers unless overwrite is enabled', () => {
    const installed = buildItem({ installed: true, installedVersion: '1.9.3' });

    const withoutOverwrite = planDriverPackageImport([installed]);
    expect(withoutOverwrite.installable).toHaveLength(0);
    expect(withoutOverwrite.skipped).toHaveLength(1);

    const withOverwrite = planDriverPackageImport([installed], { forceOverwrite: true });
    expect(withOverwrite.installable).toHaveLength(1);
    expect(withOverwrite.skipped).toHaveLength(0);
  });

  it('blocks revision mismatches even when overwrite is enabled', () => {
    const mismatched = buildItem({
      installed: true,
      revisionMismatch: true,
      packageRevision: 'src-deadbeefdeadbeef',
      expectedRevision: 'src-0a451007282c8777',
    });

    for (const forceOverwrite of [false, true]) {
      const plan = planDriverPackageImport([mismatched], { forceOverwrite });
      expect(plan.blocked).toHaveLength(1);
      expect(plan.installable).toHaveLength(0);
      expect(plan.skipped).toHaveLength(0);
    }
  });

  it('blocks platform mismatches even when overwrite is enabled', () => {
    const crossPlatform = buildItem({ platformMismatch: true, goos: 'windows', goarch: 'amd64' });

    for (const forceOverwrite of [false, true]) {
      const plan = planDriverPackageImport([crossPlatform], { forceOverwrite });
      expect(plan.blocked).toHaveLength(1);
      expect(plan.installable).toHaveLength(0);
    }
  });

  it('prefers the block reason over the installed shortcut', () => {
    // 同时命中"已安装"与"revision 不匹配"时必须归入 blocked：装上去也起不来。
    const plan = planDriverPackageImport(
      [buildItem({ installed: true, revisionMismatch: true })],
      { forceOverwrite: true },
    );
    expect(plan.blocked).toHaveLength(1);
    expect(plan.installable).toHaveLength(0);
  });

  it('keeps the three groups disjoint across a mixed package', () => {
    const items = [
      buildItem({ driverType: 'mariadb' }),
      buildItem({ driverType: 'duckdb', installed: true }),
      buildItem({ driverType: 'mongodb', revisionMismatch: true }),
      buildItem({ driverType: 'sqlite', platformMismatch: true }),
    ];
    const plan = planDriverPackageImport(items);

    expect(plan.installable.map((item) => item.driverType)).toEqual(['mariadb']);
    expect(plan.skipped.map((item) => item.driverType)).toEqual(['duckdb']);
    expect(plan.blocked.map((item) => item.driverType).sort()).toEqual(['mongodb', 'sqlite']);
    expect(plan.installable.length + plan.skipped.length + plan.blocked.length).toBe(items.length);
  });
});

describe('resolveDriverPackageImportStatus', () => {
  it('maps each combination to its status code', () => {
    expect(resolveDriverPackageImportStatus(buildItem())).toBe('install');
    expect(resolveDriverPackageImportStatus(buildItem({ installed: true }))).toBe('skip_installed');
    expect(resolveDriverPackageImportStatus(buildItem({ installed: true }), { forceOverwrite: true })).toBe('overwrite');
    expect(resolveDriverPackageImportStatus(buildItem({ revisionMismatch: true }))).toBe('revision_mismatch');
    expect(resolveDriverPackageImportStatus(buildItem({ platformMismatch: true }))).toBe('platform_mismatch');
  });

  it('reports platform mismatch ahead of revision mismatch', () => {
    expect(
      resolveDriverPackageImportStatus(buildItem({ platformMismatch: true, revisionMismatch: true })),
    ).toBe('platform_mismatch');
  });
});

describe('summarizeDriverPackageImport', () => {
  it('reports success when nothing fails', () => {
    const summary = summarizeDriverPackageImport({ success: 3, failed: 0, skipped: 2, blocked: 0 });
    expect(summary.level).toBe('success');
    expect(summary.key).toBe('driver_manager.import.summary.success');
    expect(summary.params).toEqual({ success: 3, skip: 2 });
  });

  it('reports partial when some succeed and some fail', () => {
    const summary = summarizeDriverPackageImport({ success: 2, failed: 1, skipped: 0, blocked: 0 });
    expect(summary.level).toBe('warning');
    expect(summary.key).toBe('driver_manager.import.summary.partial');
    expect(summary.params).toEqual({ success: 2, failed: 1, skip: 0 });
  });

  it('reports failure when nothing succeeds but something fails', () => {
    const summary = summarizeDriverPackageImport({ success: 0, failed: 2, skipped: 0, blocked: 0 });
    expect(summary.level).toBe('error');
    expect(summary.key).toBe('driver_manager.import.summary.failed');
    expect(summary.params).toEqual({ failed: 2 });
  });

  it('reports the installed-only case separately from the blocked-only case', () => {
    const allSkipped = summarizeDriverPackageImport({ success: 0, failed: 0, skipped: 4, blocked: 0 });
    expect(allSkipped.level).toBe('info');
    expect(allSkipped.key).toBe('driver_manager.import.summary.skipped_all');

    const allBlocked = summarizeDriverPackageImport({ success: 0, failed: 0, skipped: 0, blocked: 4 });
    expect(allBlocked.level).toBe('error');
    expect(allBlocked.key).toBe('driver_manager.import.blocked_all');
  });

  it('prefers the blocked message when nothing was attempted at all', () => {
    const summary = summarizeDriverPackageImport({ success: 0, failed: 0, skipped: 3, blocked: 2 });
    expect(summary.key).toBe('driver_manager.import.blocked_all');
  });

  it('reports cancellation as info, not as a failure', () => {
    // 用户点了取消：已装的如实报数，剩下的只是「没装」，弹 error 会让人以为出了故障。
    const summary = summarizeDriverPackageImport({
      success: 2, failed: 0, skipped: 1, blocked: 0, canceled: true,
    });
    expect(summary.level).toBe('info');
    expect(summary.key).toBe('driver_manager.import.summary.canceled');
    expect(summary.params).toEqual({ success: 2, skip: 1 });
  });

  it('keeps the cancel message even when earlier rows had failed', () => {
    // 取消优先于其它分支：哪怕中途也失败过，用户的主诉求是「我按了取消」。
    const summary = summarizeDriverPackageImport({
      success: 1, failed: 3, skipped: 0, blocked: 0, canceled: true,
    });
    expect(summary.key).toBe('driver_manager.import.summary.canceled');
  });

  it('keeps the cancel message when nothing had installed yet', () => {
    const summary = summarizeDriverPackageImport({
      success: 0, failed: 0, skipped: 0, blocked: 2, canceled: true,
    });
    expect(summary.level).toBe('info');
    expect(summary.key).toBe('driver_manager.import.summary.canceled');
  });

  it('ignores a falsy canceled flag so unchanged callers keep their old branch', () => {
    const summary = summarizeDriverPackageImport({
      success: 3, failed: 0, skipped: 0, blocked: 0, canceled: false,
    });
    expect(summary.key).toBe('driver_manager.import.summary.success');
  });
});

describe('normalizeDriverPackageExportProgress', () => {
  const event = {
    jobId: 'driver-package-export-1',
    status: 'running',
    written: 1024,
    total: 4096,
    currentDriver: 'dameng',
  };

  it('normalizes a matching event', () => {
    expect(normalizeDriverPackageExportProgress(event, 'driver-package-export-1')).toEqual({
      status: 'running',
      written: 1024,
      total: 4096,
      currentDriver: 'dameng',
      message: '',
    });
  });

  it('drops events from another job so parallel or stale exports cannot cross-talk', () => {
    expect(normalizeDriverPackageExportProgress(event, 'driver-package-export-2')).toBeNull();
    expect(normalizeDriverPackageExportProgress(event, '')).toBeNull();
  });

  it('drops events without a job id', () => {
    expect(normalizeDriverPackageExportProgress({ ...event, jobId: '' }, 'driver-package-export-1')).toBeNull();
  });

  it('drops malformed payloads instead of throwing', () => {
    expect(normalizeDriverPackageExportProgress(null, 'job')).toBeNull();
    expect(normalizeDriverPackageExportProgress('running', 'job')).toBeNull();
  });

  it('clamps negative byte counts to zero', () => {
    const normalized = normalizeDriverPackageExportProgress(
      { ...event, written: -5, total: Number.NaN },
      'driver-package-export-1',
    );
    expect(normalized?.written).toBe(0);
    expect(normalized?.total).toBe(0);
  });
});

describe('computeDriverPackageExportPercent', () => {
  it('converts written bytes to a percentage', () => {
    expect(computeDriverPackageExportPercent(1024, 4096)).toBe(25);
  });

  it('caps at 100 so an overshooting backend cannot render past the bar', () => {
    expect(computeDriverPackageExportPercent(8192, 4096)).toBe(100);
  });

  it('returns 0 when the denominator is unknown', () => {
    // 分母为 0 时进度不可知，绝不能当成"已完成"显示 100%。
    expect(computeDriverPackageExportPercent(1024, 0)).toBe(0);
    expect(computeDriverPackageExportPercent(0, 0)).toBe(0);
  });
});

describe('formatDriverPackageBytes', () => {
  it('formats each unit boundary', () => {
    expect(formatDriverPackageBytes(0)).toBe('0 B');
    expect(formatDriverPackageBytes(512)).toBe('512 B');
    expect(formatDriverPackageBytes(1024)).toBe('1 KB');
    expect(formatDriverPackageBytes(1536)).toBe('1.5 KB');
    expect(formatDriverPackageBytes(15.9 * 1024 * 1024)).toBe('15.9 MB');
    expect(formatDriverPackageBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB');
  });

  it('treats negative and non-finite input as zero', () => {
    expect(formatDriverPackageBytes(-1)).toBe('0 B');
    expect(formatDriverPackageBytes(Number.NaN)).toBe('0 B');
  });
});

describe('isDriverPackageExportCanceled', () => {
  it('recognizes the structured runtime-cancel mark', () => {
    expect(isDriverPackageExportCanceled({
      success: false,
      message: 'Export canceled',
      data: { canceled: true },
    })).toBe(true);
  });

  it('recognizes the save-dialog cancel without a mark', () => {
    expect(isDriverPackageExportCanceled({ success: false, message: '已取消' })).toBe(true);
  });

  it('does not treat a plain failure as cancel', () => {
    expect(isDriverPackageExportCanceled({ success: false, message: 'Disk full' })).toBe(false);
  });

  it('ignores the mark on a successful result', () => {
    expect(isDriverPackageExportCanceled({ success: true, data: { canceled: true } })).toBe(false);
  });

  it('handles malformed input', () => {
    expect(isDriverPackageExportCanceled(null)).toBe(false);
    expect(isDriverPackageExportCanceled(undefined)).toBe(false);
  });
});

describe('isDriverPackageExportRunCanceled', () => {
  it('recognizes only the runtime-cancel mark', () => {
    expect(isDriverPackageExportRunCanceled({
      success: false,
      message: 'Export canceled',
      data: { canceled: true },
    })).toBe(true);
  });

  it('does not fire for the save-dialog cancel, which has no mark', () => {
    // 对话框取消不该弹「已取消导出」：任务根本没开始，提示只是噪音。
    // 但整体上仍算取消，必须继续被 isDriverPackageExportCanceled 认下。
    const dialogCancel = { success: false, message: '已取消' };
    expect(isDriverPackageExportRunCanceled(dialogCancel)).toBe(false);
    expect(isDriverPackageExportCanceled(dialogCancel)).toBe(true);
  });

  it('does not fire on success or plain failure', () => {
    expect(isDriverPackageExportRunCanceled({ success: true, data: { canceled: true } })).toBe(false);
    expect(isDriverPackageExportRunCanceled({ success: false, message: 'Disk full' })).toBe(false);
    expect(isDriverPackageExportRunCanceled(null)).toBe(false);
  });
});

describe('buildDriverPackageExportJobId', () => {
  it('produces unique ids so concurrent exports never share a progress channel', () => {
    const ids = new Set(Array.from({ length: 50 }, () => buildDriverPackageExportJobId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^driver-package-export-\d+-[a-z0-9]+$/);
    }
  });
});
