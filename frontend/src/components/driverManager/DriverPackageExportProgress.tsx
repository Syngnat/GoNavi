import { Button, message } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import React from 'react';

import { t } from '../../i18n';
import { EventsOn } from '../../../wailsjs/runtime';
import { DriverBatchProgressBar } from './DriverBatchProgressBar';
import { CancelExportFile } from '../../../wailsjs/go/app/App';
import {
  computeDriverPackageExportPercent,
  formatDriverPackageBytes,
  normalizeDriverPackageExportProgress,
  type DriverPackageExportProgressState,
} from './driverPackageTransfer';

// 驱动包导出进度条。
//
// 后端 driver:package-export-progress 是广播事件，payload 带 jobId。必须按 jobId
// 过滤：否则并行导出、或上一次导出迟到的收尾事件会串到当前进度条上。
//
// 「正在取消」是纯展示态，自持即可 —— 放进父组件只会让调用方被迫多传两个 state。

export type DriverPackageExportProgressProps = {
  /** 本次导出的任务 id；为空表示没有进行中的导出。 */
  jobId: string;
};

/** 尚无事件到达时的占位：后端要等用户选完保存路径才开始发事件。 */
const PENDING_PROGRESS: DriverPackageExportProgressState = {
  status: 'start',
  written: 0,
  total: 0,
  currentDriver: '',
  message: '',
};

export const DriverPackageExportProgress: React.FC<DriverPackageExportProgressProps> = ({ jobId }) => {
  const activeJobId = String(jobId || '').trim();
  const [progress, setProgress] = React.useState<DriverPackageExportProgressState>(PENDING_PROGRESS);
  const [canceling, setCanceling] = React.useState(false);

  React.useEffect(() => {
    if (!activeJobId) {
      return;
    }
    // 新一轮导出的 jobId 变了，重置上一轮的残留态（进度条会一直挂着直到卸载）。
    setProgress(PENDING_PROGRESS);
    setCanceling(false);
    const off = EventsOn('driver:package-export-progress', (event: unknown) => {
      const normalized = normalizeDriverPackageExportProgress(event, activeJobId);
      if (!normalized) {
        return;
      }
      // 后端确认收尾后解除「正在取消」，否则按钮会一直转圈。
      if (normalized.status === 'canceled' || normalized.status === 'error') {
        setCanceling(false);
      }
      setProgress(normalized);
    });
    return () => {
      if (typeof off === 'function') {
        off();
      }
    };
  }, [activeJobId]);

  if (!activeJobId) {
    return null;
  }

  const percent = computeDriverPackageExportPercent(progress.written, progress.total);
  const detailText = progress.total > 0
    ? t('driver_manager.export.progress_detail', {
      written: formatDriverPackageBytes(progress.written),
      total: formatDriverPackageBytes(progress.total),
    })
    : '';
  const description = [progress.currentDriver, detailText].filter(Boolean).join(' · ');

  // 取消被后端拒绝（任务已结束或 IPC 异常）时回退按钮态，让用户能重试。
  const handleCancel = async () => {
    setCanceling(true);
    try {
      const response = await CancelExportFile(activeJobId);
      if (response?.success) {
        return;
      }
      setCanceling(false);
      const failedMessage = String(response?.message || '').trim();
      if (failedMessage) {
        void message.warning(failedMessage);
      }
    } catch (error) {
      setCanceling(false);
      void message.warning(error instanceof Error ? error.message : String(error || ''));
    }
  };

  return (
    <DriverBatchProgressBar
      icon={<ExportOutlined />}
      title={t('driver_manager.export.progress_title', { percent: Math.round(percent) })}
      description={description}
      percent={percent}
      actions={(
        <Button size="small" danger ghost loading={canceling} onClick={() => void handleCancel()}>
          {canceling ? t('driver_manager.export.canceling') : t('driver_manager.export.cancel')}
        </Button>
      )}
    />
  );
};

export default DriverPackageExportProgress;
