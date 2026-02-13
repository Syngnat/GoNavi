import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Modal, Progress, Space, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import {
  DownloadDriverPackage,
  GetDriverStatusList,
  RemoveDriverPackage,
} from '../../wailsjs/go/app/App';

const { Text } = Typography;

type DriverStatusRow = {
  type: string;
  name: string;
  builtIn: boolean;
  packageSizeText?: string;
  runtimeAvailable: boolean;
  packageInstalled: boolean;
  connectable: boolean;
  defaultDownloadUrl?: string;
  message?: string;
};

type DriverProgressEvent = {
  driverType?: string;
  status?: 'start' | 'downloading' | 'done' | 'error';
  message?: string;
  percent?: number;
};

type ProgressState = {
  status: 'start' | 'downloading' | 'done' | 'error';
  message: string;
  percent: number;
};

const DriverManagerModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [downloadDir, setDownloadDir] = useState('');
  const [rows, setRows] = useState<DriverStatusRow[]>([]);
  const [actionDriver, setActionDriver] = useState('');
  const [progressMap, setProgressMap] = useState<Record<string, ProgressState>>({});

  const refreshStatus = useCallback(async (toastOnError = true) => {
    setLoading(true);
    try {
      const res = await GetDriverStatusList(downloadDir, '');
      if (!res?.success) {
        if (toastOnError) {
          message.error(res?.message || '拉取驱动状态失败');
        }
        return;
      }

      const data = (res?.data || {}) as any;
      const resolvedDir = String(data.downloadDir || '').trim();
      const drivers = Array.isArray(data.drivers) ? data.drivers : [];

      if (resolvedDir) {
        setDownloadDir(resolvedDir);
      }

      const nextRows: DriverStatusRow[] = drivers.map((item: any) => ({
        type: String(item.type || '').trim(),
        name: String(item.name || item.type || '').trim(),
        builtIn: !!item.builtIn,
        packageSizeText: String(item.packageSizeText || '').trim() || undefined,
        runtimeAvailable: !!item.runtimeAvailable,
        packageInstalled: !!item.packageInstalled,
        connectable: !!item.connectable,
        defaultDownloadUrl: String(item.defaultDownloadUrl || '').trim() || undefined,
        message: String(item.message || '').trim() || undefined,
      }));
      setRows(nextRows);
    } catch (err: any) {
      if (toastOnError) {
        message.error(`拉取驱动状态失败：${err?.message || String(err)}`);
      }
    } finally {
      setLoading(false);
    }
  }, [downloadDir]);

  useEffect(() => {
    if (!open) {
      return;
    }
    refreshStatus(false);
  }, [open, refreshStatus]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const off = EventsOn('driver:download-progress', (event: DriverProgressEvent) => {
      if (!event) {
        return;
      }
      const driverType = String(event.driverType || '').trim().toLowerCase();
      const status = event.status;
      if (!driverType || !status) {
        return;
      }
      const messageText = String(event.message || '').trim();
      const percent = Math.max(0, Math.min(100, Number(event.percent || 0)));
      setProgressMap((prev) => ({
        ...prev,
        [driverType]: {
          status,
          message: messageText,
          percent,
        },
      }));
    });
    return () => {
      off();
    };
  }, [open]);

  const installDriver = useCallback(async (row: DriverStatusRow) => {
    setActionDriver(row.type);
    setProgressMap((prev) => ({
      ...prev,
      [row.type]: {
        status: 'start',
        message: '开始安装',
        percent: 0,
      },
    }));
    try {
      const result = await DownloadDriverPackage(row.type, '', downloadDir);
      if (!result?.success) {
        message.error(result?.message || `安装 ${row.name} 失败`);
        return;
      }
      message.success(`${row.name} 已安装启用`);
      refreshStatus(false);
    } finally {
      setActionDriver('');
    }
  }, [downloadDir, refreshStatus]);

  const removeDriver = useCallback(async (row: DriverStatusRow) => {
    setActionDriver(row.type);
    try {
      const result = await RemoveDriverPackage(row.type, downloadDir);
      if (!result?.success) {
        message.error(result?.message || `移除 ${row.name} 失败`);
        return;
      }
      message.success(`${row.name} 已移除`);
      setProgressMap((prev) => {
        const next = { ...prev };
        delete next[row.type];
        return next;
      });
      refreshStatus(false);
    } finally {
      setActionDriver('');
    }
  }, [downloadDir, refreshStatus]);

  const columns = useMemo(() => {
    return [
      {
        title: '数据源',
        dataIndex: 'name',
        key: 'name',
        width: 150,
      },
      {
        title: '安装包大小',
        dataIndex: 'packageSizeText',
        key: 'packageSizeText',
        width: 120,
        render: (_: string | undefined, row: DriverStatusRow) => row.packageSizeText || '-',
      },
      {
        title: '状态',
        key: 'status',
        width: 140,
        render: (_: string, row: DriverStatusRow) => {
          if (row.builtIn) {
            return <Tag color="success">内置可用</Tag>;
          }
          const progress = progressMap[row.type];
          if (progress && (progress.status === 'start' || progress.status === 'downloading')) {
            return <Tag color="processing">安装中 {Math.round(progress.percent)}%</Tag>;
          }
          if (row.connectable) {
            return <Tag color="success">已启用</Tag>;
          }
          if (row.packageInstalled) {
            return <Tag color="warning">已安装</Tag>;
          }
          return <Tag color="default">未启用</Tag>;
        },
      },
      {
        title: '安装进度',
        key: 'progress',
        width: 170,
        render: (_: string, row: DriverStatusRow) => {
          if (row.builtIn) {
            return <Text type="secondary">-</Text>;
          }

          const progress = progressMap[row.type];
          let percent = 0;
          let status: 'normal' | 'exception' | 'active' | 'success' = 'normal';

          if (progress?.status === 'error') {
            percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
            status = 'exception';
          } else if (progress && (progress.status === 'start' || progress.status === 'downloading')) {
            percent = Math.max(1, Math.min(99, Math.round(progress.percent || 0)));
            status = 'active';
          } else if (row.connectable || row.packageInstalled) {
            percent = 100;
            status = 'success';
          }

          return <Progress percent={percent} status={status} size="small" />;
        },
      },
      {
        title: '操作',
        key: 'actions',
        width: 190,
        render: (_: string, row: DriverStatusRow) => {
          if (row.builtIn) {
            return <Text type="secondary">-</Text>;
          }
          const isSlimBuildUnavailable = (row.message || '').includes('精简构建');
          const loadingAction = actionDriver === row.type;
          if (isSlimBuildUnavailable && !row.packageInstalled) {
            return <Text type="secondary">需 Full 版</Text>;
          }
          if (row.connectable) {
            return (
              <Button
                danger
                icon={<DeleteOutlined />}
                loading={loadingAction}
                onClick={() => removeDriver(row)}
              >
                移除
              </Button>
            );
          }
          return (
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={loadingAction}
              onClick={() => installDriver(row)}
            >
              安装启用
            </Button>
          );
        },
      },
    ];
  }, [actionDriver, installDriver, progressMap, removeDriver]);

  return (
    <Modal
      title="驱动管理"
      open={open}
      onCancel={onClose}
      width={980}
      destroyOnClose
      footer={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => refreshStatus(true)} loading={loading}>
          刷新
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>
          关闭
        </Button>,
      ]}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Text type="secondary">除 MySQL / Redis / Oracle / PostgreSQL 外，其他数据源需先安装启用后再连接。</Text>

        <Table
          rowKey="type"
          loading={loading}
          columns={columns as any}
          dataSource={rows}
          pagination={false}
          size="middle"
        />
      </Space>
    </Modal>
  );
};

export default DriverManagerModal;
