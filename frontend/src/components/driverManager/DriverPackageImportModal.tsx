import Modal from '../common/ResizableDraggableModal';
import React from 'react';
import { Alert, Button, Checkbox, Table, Tag } from 'antd';

import { t } from '../../i18n';
import {
  planDriverPackageImport,
  resolveDriverPackageImportStatus,
  type DriverPackageImportStatus,
  type DriverPackageInspectItem,
} from './driverPackageTransfer';

// 驱动包 ZIP 的批量导入确认弹窗：展示包内驱动与本机状态，让用户确认后再逐个安装。
// 组装与安装编排在 DriverManagerModal，本组件只负责渲染与选择。

export type DriverPackageImportModalProps = {
  open: boolean;
  loading?: boolean;
  /** 正在导入：禁用关闭与确认，避免中途改配置。 */
  importing?: boolean;
  /** 导入进度条，渲染在说明与列表之间；由调用方决定呈现。 */
  progress?: React.ReactNode;
  drivers: DriverPackageInspectItem[];
  forceOverwrite: boolean;
  onForceOverwriteChange: (value: boolean) => void;
  onConfirm: () => void;
  /** 未导入时关闭弹窗。 */
  onCancel: () => void;
  /** 导入中点击取消：终止尚未启动的驱动。 */
  onAbort: () => void;
};

const STATUS_TAG_COLORS: Record<DriverPackageImportStatus, string> = {
  install: 'blue',
  skip_installed: 'default',
  overwrite: 'orange',
  revision_mismatch: 'red',
  platform_mismatch: 'red',
};

const resolveStatusLabelKey = (status: DriverPackageImportStatus) => (
  `driver_manager.import.status.${status}`
);

const DriverPackageImportModal: React.FC<DriverPackageImportModalProps> = ({
  open,
  loading = false,
  importing = false,
  progress,
  drivers,
  forceOverwrite,
  onForceOverwriteChange,
  onConfirm,
  onCancel,
  onAbort,
}) => {
  const plan = React.useMemo(
    () => planDriverPackageImport(drivers, { forceOverwrite }),
    [drivers, forceOverwrite],
  );
  const hasMismatch = plan.blocked.some((item) => item.revisionMismatch);
  const hasCrossPlatform = plan.blocked.some((item) => item.platformMismatch);

  const columns = React.useMemo(() => [
    {
      title: t('driver_manager.import.column.driver'),
      dataIndex: 'driverName',
      key: 'driverName',
      render: (_value: unknown, item: DriverPackageInspectItem) => (
        <span>{item.driverName || item.driverType}</span>
      ),
    },
    {
      title: t('driver_manager.import.column.version'),
      dataIndex: 'version',
      key: 'version',
      render: (_value: unknown, item: DriverPackageInspectItem) => (
        <span>{item.version || '-'}</span>
      ),
    },
    {
      title: t('driver_manager.import.column.status'),
      key: 'status',
      render: (_value: unknown, item: DriverPackageInspectItem) => {
        const status = resolveDriverPackageImportStatus(item, { forceOverwrite });
        return <Tag color={STATUS_TAG_COLORS[status]}>{t(resolveStatusLabelKey(status))}</Tag>;
      },
    },
  ], [forceOverwrite]);

  return (
    <Modal
      open={open}
      title={t('driver_manager.import.title')}
      width={640}
      onCancel={onCancel}
      maskClosable={!importing}
      closable={!importing}
      footer={[
        <Button key="cancel" danger={importing} onClick={importing ? onAbort : onCancel}>
          {importing ? t('driver_manager.import.abort') : t('common.cancel')}
        </Button>,
        <Button
          key="confirm"
          type="primary"
          loading={importing || loading}
          disabled={plan.installable.length === 0 && plan.blocked.length === 0}
          onClick={onConfirm}
        >
          {t('driver_manager.import.confirm')}
        </Button>,
      ]}
    >
      {progress ? <div style={{ marginBottom: 12 }}>{progress}</div> : null}
      {hasMismatch && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('driver_manager.import.revision_mismatch_hint', {
            actual: plan.blocked.find((item) => item.revisionMismatch)?.packageRevision || '-',
            expected: plan.blocked.find((item) => item.revisionMismatch)?.expectedRevision || '-',
          })}
        />
      )}
      {hasCrossPlatform && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('driver_manager.import.platform_mismatch_hint')}
        />
      )}
      <Table<DriverPackageInspectItem>
        rowKey={(item) => item.driverType}
        size="small"
        loading={loading}
        dataSource={drivers}
        columns={columns}
        pagination={false}
        scroll={{ y: 240 }}
      />
      <Checkbox
        style={{ marginTop: 12 }}
        checked={forceOverwrite}
        disabled={importing}
        onChange={(event) => onForceOverwriteChange(event.target.checked)}
      >
        {t('driver_manager.import.force_overwrite')}
      </Checkbox>
    </Modal>
  );
};

export default DriverPackageImportModal;
