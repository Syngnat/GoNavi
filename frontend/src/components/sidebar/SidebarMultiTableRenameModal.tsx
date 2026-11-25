import React, { useEffect } from 'react';
import { Form, Input } from 'antd';

import { t } from '../../i18n';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import Modal from '../common/ResizableDraggableModal';
import type { SidebarMultiTableRenameEntry } from './sidebarMultiTableRename';

type SidebarMultiTableRenameFormValues = {
  tables?: Array<{ newName?: string }>;
};

type SidebarMultiTableRenameModalProps = {
  open: boolean;
  entries: ReadonlyArray<SidebarMultiTableRenameEntry>;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (newNames: string[]) => void;
};

const tableRowKey = (entry: SidebarMultiTableRenameEntry): string => (
  String(entry.node.key ?? `${entry.connectionId}-${entry.dbName}-${entry.schemaName || ''}-${entry.oldTableName}`)
);

export const SidebarMultiTableRenameModal: React.FC<SidebarMultiTableRenameModalProps> = ({
  open,
  entries,
  submitting,
  onCancel,
  onSubmit,
}) => {
  const [form] = Form.useForm<SidebarMultiTableRenameFormValues>();

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      tables: entries.map((entry) => ({ newName: entry.newTableName })),
    });
  }, [entries, form, open]);

  return (
    <Modal
      title={t('sidebar.modal.rename_table.batch_title', { count: entries.length })}
      open={open}
      width={620}
      confirmLoading={submitting}
      closable={!submitting}
      maskClosable={!submitting}
      onOk={() => form.submit()}
      onCancel={() => {
        if (!submitting) onCancel();
      }}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          const rows = Array.isArray(values.tables) ? values.tables : [];
          onSubmit(entries.map((_, index) => String(rows[index]?.newName ?? '')));
        }}
      >
        <div style={{ maxHeight: '52vh', overflowY: 'auto', paddingRight: 4 }}>
          {entries.map((entry, index) => (
            <div
              key={tableRowKey(entry)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '10px 0',
                borderBottom: index === entries.length - 1 ? 'none' : '1px solid rgba(127, 127, 127, 0.18)',
              }}
            >
              <div style={{ flex: '0 0 44%', minWidth: 0, paddingTop: 5 }}>
                <div
                  title={entry.oldTableName}
                  style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {entry.oldTableName}
                </div>
                <div
                  title={entry.databaseLabel}
                  style={{
                    marginTop: 2,
                    fontSize: 12,
                    opacity: 0.6,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.databaseLabel}
                </div>
              </div>
              <Form.Item
                name={['tables', index, 'newName']}
                style={{ flex: 1, minWidth: 0, marginBottom: 0 }}
                rules={[{
                  required: true,
                  whitespace: true,
                  message: t('sidebar.validation.new_table_name_required'),
                }]}
              >
                <Input
                  aria-label={t('sidebar.field.new_table_name')}
                  placeholder={t('sidebar.field.new_table_name')}
                  {...noAutoCapInputProps}
                />
              </Form.Item>
            </div>
          ))}
        </div>
      </Form>
    </Modal>
  );
};
