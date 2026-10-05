import { Modal, Table, Space, Button, Popconfirm } from 'antd';
import type { NacosHistoryItem } from './nacosViewerModel';
import { formatNacosHistoryTime } from '../nacos/nacosHistoryTime';
import type { NacosViewerStateApi } from './hooks/useNacosViewerState';
import type { NacosViewerBatchActionsApi } from './hooks/useNacosViewerBatchActions';

export interface NacosHistoryModalProps {
  tr: NacosViewerStateApi['tr'];
  historyOpen: NacosViewerStateApi['historyOpen'];
  setHistoryOpen: NacosViewerStateApi['setHistoryOpen'];
  historyLoading: NacosViewerStateApi['historyLoading'];
  historyItems: NacosViewerStateApi['historyItems'];
  historyPageNo: NacosViewerStateApi['historyPageNo'];
  historyTotal: NacosViewerStateApi['historyTotal'];
  loadHistory: NacosViewerBatchActionsApi['loadHistory'];
  openHistoryDetail: NacosViewerBatchActionsApi['openHistoryDetail'];
  detail: NacosViewerStateApi['detail'];
  readOnly: NacosViewerStateApi['readOnly'];
  handleRollback: NacosViewerBatchActionsApi['handleRollback'];
  rollingBack: NacosViewerStateApi['rollingBack'];
}

export const NacosHistoryModal = ({
  tr, historyOpen, setHistoryOpen, historyLoading, historyItems, historyPageNo, historyTotal,
  loadHistory, openHistoryDetail, detail, readOnly, handleRollback, rollingBack,
}: NacosHistoryModalProps) => (
  <Modal
    title={tr('nacos_viewer.history.title')}
    open={historyOpen}
    onCancel={() => setHistoryOpen(false)}
    footer={null}
    width={860}
    destroyOnHidden
  >
    <Table
      size="small"
      loading={historyLoading}
      rowKey={(row) => row.id}
      dataSource={historyItems}
      pagination={{
        current: historyPageNo,
        pageSize: 20,
        total: historyTotal,
        showSizeChanger: false,
        onChange: (page) => void loadHistory(page),
      }}
      columns={[
        {
          title: tr('nacos_viewer.history.column.id'),
          dataIndex: 'id',
          key: 'id',
          width: 120,
          ellipsis: true,
        },
        {
          title: tr('nacos_viewer.history.column.op'),
          dataIndex: 'opType',
          key: 'opType',
          width: 80,
          render: (value: string) => value || '-',
        },
        {
          title: tr('nacos_viewer.history.column.time'),
          dataIndex: 'modifiedTime',
          key: 'modifiedTime',
          width: 200,
          render: (_: string, row: NacosHistoryItem) => formatNacosHistoryTime(row.modifiedTime || row.createdTime),
        },
        {
          title: tr('nacos_viewer.column.md5'),
          dataIndex: 'md5',
          key: 'md5',
          width: 140,
          ellipsis: true,
          render: (value: string) => value || '-',
        },
        {
          title: tr('nacos_viewer.action.history'),
          key: 'actions',
          width: 220,
          render: (_: unknown, row: NacosHistoryItem) => (
            <Space>
              <Button size="small" onClick={() => void openHistoryDetail(row)}>
                {tr('nacos_viewer.action.view_history')}
              </Button>
              <Popconfirm
                title={tr('nacos_viewer.message.confirm_rollback', {
                  group: detail?.group || '',
                  dataId: detail?.dataId || '',
                  id: row.id,
                })}
                disabled={readOnly}
                onConfirm={() => void handleRollback(row)}
              >
                <Button size="small" type="primary" disabled={readOnly} loading={rollingBack}>
                  {tr('nacos_viewer.action.rollback')}
                </Button>
              </Popconfirm>
            </Space>
          ),
        },
      ]}
    />
  </Modal>
);
