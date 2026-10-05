import { Modal, Space, Tag, Radio, Table, Spin } from 'antd';
import type { NacosViewerStateApi } from './hooks/useNacosViewerState';
import type { NacosViewerBatchActionsApi } from './hooks/useNacosViewerBatchActions';

export interface NacosImportModalProps {
  tr: NacosViewerStateApi['tr'];
  importModalOpen: NacosViewerStateApi['importModalOpen'];
  setImportModalOpen: NacosViewerStateApi['setImportModalOpen'];
  handleImport: NacosViewerBatchActionsApi['handleImport'];
  importing: NacosViewerStateApi['importing'];
  importRestricted: NacosViewerStateApi['importRestricted'];
  importSelectedKeys: NacosViewerStateApi['importSelectedKeys'];
  importPreview: NacosViewerStateApi['importPreview'];
  importConflictMode: NacosViewerStateApi['importConflictMode'];
  setImportConflictMode: NacosViewerStateApi['setImportConflictMode'];
  importSelectionRows: NacosViewerStateApi['importSelectionRows'];
  setImportSelectedKeys: NacosViewerStateApi['setImportSelectedKeys'];
}

export const NacosImportModal = ({
  tr, importModalOpen, setImportModalOpen, handleImport, importing, importRestricted,
  importSelectedKeys, importPreview, importConflictMode, setImportConflictMode, importSelectionRows,
  setImportSelectedKeys,
}: NacosImportModalProps) => (
  <Modal
    title={tr('nacos_viewer.action.import')}
    open={importModalOpen}
    onCancel={() => setImportModalOpen(false)}
    onOk={() => void handleImport()}
    confirmLoading={importing}
    okButtonProps={{ disabled: importRestricted || importSelectedKeys.length === 0 }}
    width={820}
    destroyOnHidden
  >
    {importPreview ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Space wrap>
          <Tag>{importPreview.file}</Tag>
          <Tag color="blue">
            {tr('nacos_viewer.import.summary', {
              total: importPreview.total ?? 0,
              exists: importPreview.existsCount ?? 0,
              neu: importPreview.newCount ?? 0,
            })}
          </Tag>
        </Space>
        <Radio.Group
          value={importConflictMode}
          onChange={(event) => setImportConflictMode(event.target.value)}
          options={[
            { label: tr('nacos_viewer.import.conflict_skip'), value: 'skip' },
            { label: tr('nacos_viewer.import.conflict_overwrite'), value: 'overwrite' },
          ]}
        />
        <Table
          size="small"
          rowKey="selectionKey"
          dataSource={importSelectionRows}
          pagination={{ pageSize: 8 }}
          rowSelection={{
            selectedRowKeys: importSelectedKeys,
            onChange: (keys) => setImportSelectedKeys(keys.map(String)),
          }}
          columns={[
            { title: tr('nacos_viewer.field.data_id'), dataIndex: 'dataId', ellipsis: true },
            { title: tr('nacos_viewer.field.group'), dataIndex: 'group', width: 140, ellipsis: true },
            {
              title: tr('nacos_viewer.field.type'),
              dataIndex: 'type',
              width: 100,
              render: (value: string) => value || '-',
            },
            {
              title: tr('nacos_viewer.import.exists'),
              dataIndex: 'exists',
              width: 100,
              render: (value: boolean) =>
                value ? (
                  <Tag color="orange">{tr('nacos_viewer.import.exists_yes')}</Tag>
                ) : (
                  <Tag color="green">{tr('nacos_viewer.import.exists_no')}</Tag>
                ),
            },
          ]}
        />
      </div>
    ) : (
      <Spin />
    )}
  </Modal>
);
