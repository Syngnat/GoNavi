import React, { useMemo } from 'react';
import { Checkbox, Empty, Form, Input, Select, Space } from 'antd';
import type { FormInstance } from 'antd/es/form';
import { FolderOpenOutlined } from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import type { ConnectionTag, SavedConnection, SavedQuery } from '../../types';
import type { DatabaseCharsetOption, DatabaseCollationOption } from '../../utils/databaseCharset';
import { t } from '../../i18n';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { APP_NESTED_MODAL_Z_INDEX } from '../../utils/overlayZIndex';

const getConnectionTagDescendantIds = (
  connectionTags: ConnectionTag[],
  rootTagId: string,
): Set<string> => {
  const descendants = new Set<string>();
  const pending = [rootTagId];
  while (pending.length > 0) {
    const parentTagId = pending.pop();
    if (!parentTagId) continue;
    connectionTags.forEach((tag) => {
      if (tag.parentTagId !== parentTagId || descendants.has(tag.id)) return;
      descendants.add(tag.id);
      pending.push(tag.id);
    });
  }
  return descendants;
};

export const buildConnectionTagParentOptions = (
  connectionTags: ConnectionTag[],
  editingTagId: string,
) => {
  const excludedTagIds = editingTagId
    ? new Set([editingTagId, ...getConnectionTagDescendantIds(connectionTags, editingTagId)])
    : new Set<string>();
  const tagById = new Map(connectionTags.map((tag) => [tag.id, tag]));

  return connectionTags
    .filter((tag) => !excludedTagIds.has(tag.id))
    .map((tag) => {
      const names: string[] = [];
      const visited = new Set<string>();
      let current: ConnectionTag | undefined = tag;
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        names.unshift(current.name);
        current = current.parentTagId ? tagById.get(current.parentTagId) : undefined;
      }
      return { value: tag.id, label: names.join(' / ') || tag.name };
    });
};

export const buildConnectionTagSelectableConnections = (
  connections: SavedConnection[],
  connectionTags: ConnectionTag[],
  editingTagId: string,
): SavedConnection[] => {
  const currentTagId = editingTagId.trim();
  const connectionIdsAssignedToOtherTags = new Set<string>();

  connectionTags.forEach((tag) => {
    if (tag.id === currentTagId) return;
    tag.connectionIds.forEach((connectionId) => {
      connectionIdsAssignedToOtherTags.add(connectionId);
    });
  });

  return connections.filter(
    (connection) => !connectionIdsAssignedToOtherTags.has(connection.id),
  );
};

const resolveConnectionTagParentId = (
  value: unknown,
  connectionTags: ConnectionTag[],
  editingTagId: string,
): string | undefined => {
  const parentTagId = typeof value === 'string' ? value.trim() : '';
  if (!parentTagId) return undefined;
  return buildConnectionTagParentOptions(connectionTags, editingTagId)
    .some((option) => option.value === parentTagId)
    ? parentTagId
    : undefined;
};

type SidebarEntityModalsProps = {
  connections: SavedConnection[];
  connectionTags: ConnectionTag[];
  modalPanelStyle: React.CSSProperties;
  modalSectionStyle: React.CSSProperties;
  modalScrollSectionStyle: React.CSSProperties;
  renderSidebarModalTitle: (icon: React.ReactNode, title: string, description: string) => React.ReactNode;
  isCreateTagModalOpen: boolean;
  setIsCreateTagModalOpen: (open: boolean) => void;
  createTagForm: FormInstance;
  renameViewTarget: any;
  updateConnectionTag: (tag: ConnectionTag) => void;
  addConnectionTag: (tag: ConnectionTag) => void;
  isCreateDbModalOpen: boolean;
  setIsCreateDbModalOpen: (open: boolean) => void;
  createDbForm: FormInstance;
  handleCreateDatabase: () => void;
  createDbTarget: any;
  createDbCharsets: DatabaseCharsetOption[];
  createDbCollations: DatabaseCollationOption[];
  loadingCreateDbOptions: boolean;
  isCreateSchemaModalOpen: boolean;
  setIsCreateSchemaModalOpen: (open: boolean) => void;
  createSchemaForm: FormInstance;
  createSchemaTarget: any;
  setCreateSchemaTarget: (target: any) => void;
  handleCreateSchema: () => void;
  isRenameSchemaModalOpen: boolean;
  setIsRenameSchemaModalOpen: (open: boolean) => void;
  renameSchemaForm: FormInstance;
  renameSchemaTarget: any;
  setRenameSchemaTarget: (target: any) => void;
  handleRenameSchema: () => void;
  isRenameDbModalOpen: boolean;
  setIsRenameDbModalOpen: (open: boolean) => void;
  renameDbForm: FormInstance;
  renameDbTarget: any;
  setRenameDbTarget: (target: any) => void;
  handleRenameDatabase: () => void;
  isRenameTableModalOpen: boolean;
  setIsRenameTableModalOpen: (open: boolean) => void;
  renameTableForm: FormInstance;
  renameTableTarget: any;
  setRenameTableTarget: (target: any) => void;
  handleRenameTable: () => void;
  isRenameViewModalOpen: boolean;
  setIsRenameViewModalOpen: (open: boolean) => void;
  renameViewForm: FormInstance;
  setRenameViewTarget: (target: any) => void;
  handleRenameView: () => void;
  isRenameSavedQueryModalOpen: boolean;
  setIsRenameSavedQueryModalOpen: (open: boolean) => void;
  renameSavedQueryForm: FormInstance;
  renameSavedQueryTarget: SavedQuery | null;
  setRenameSavedQueryTarget: (target: SavedQuery | null) => void;
  handleRenameSavedQuery: () => void;
};

export const SidebarEntityModals: React.FC<SidebarEntityModalsProps> = ({
  connections,
  connectionTags,
  modalPanelStyle,
  modalSectionStyle,
  modalScrollSectionStyle,
  renderSidebarModalTitle,
  isCreateTagModalOpen,
  setIsCreateTagModalOpen,
  createTagForm,
  renameViewTarget,
  updateConnectionTag,
  addConnectionTag,
  isCreateDbModalOpen,
  setIsCreateDbModalOpen,
  createDbForm,
  handleCreateDatabase,
  createDbTarget,
  createDbCharsets,
  createDbCollations,
  loadingCreateDbOptions,
  isCreateSchemaModalOpen,
  setIsCreateSchemaModalOpen,
  createSchemaForm,
  createSchemaTarget,
  setCreateSchemaTarget,
  handleCreateSchema,
  isRenameSchemaModalOpen,
  setIsRenameSchemaModalOpen,
  renameSchemaForm,
  renameSchemaTarget,
  setRenameSchemaTarget,
  handleRenameSchema,
  isRenameDbModalOpen,
  setIsRenameDbModalOpen,
  renameDbForm,
  renameDbTarget,
  setRenameDbTarget,
  handleRenameDatabase,
  isRenameTableModalOpen,
  setIsRenameTableModalOpen,
  renameTableForm,
  renameTableTarget,
  setRenameTableTarget,
  handleRenameTable,
  isRenameViewModalOpen,
  setIsRenameViewModalOpen,
  renameViewForm,
  setRenameViewTarget,
  handleRenameView,
  isRenameSavedQueryModalOpen,
  setIsRenameSavedQueryModalOpen,
  renameSavedQueryForm,
  renameSavedQueryTarget,
  setRenameSavedQueryTarget,
  handleRenameSavedQuery,
}) => {
  const editingTagId = renameViewTarget?.type === 'tag'
    ? String(renameViewTarget?.dataRef?.id || '')
    : '';
  const selectableConnections = buildConnectionTagSelectableConnections(
    connections,
    connectionTags,
    editingTagId,
  );

  const createDatabaseCharsetSupported = Boolean(
    createDbTarget?.dataRef?.config
      && getDataSourceCapabilities(createDbTarget.dataRef.config).supportsCreateDatabaseCharset,
  );
  const selectedCreateDbCharset = Form.useWatch('charset', createDbForm);
  const createDatabaseCharsetOptions = useMemo(
    () => createDbCharsets.map((charset) => ({
      value: charset.name,
      label: charset.defaultCollation
        ? `${charset.name}（${charset.defaultCollation}）`
        : charset.name,
    })),
    [createDbCharsets],
  );
  const createDatabaseCollationOptions = useMemo(
    () => createDbCollations
      .filter((collation) => !selectedCreateDbCharset || collation.charset === selectedCreateDbCharset)
      .map((collation) => ({ value: collation.name, label: collation.name })),
    [createDbCollations, selectedCreateDbCharset],
  );

  return (<>
    <Modal
      title={renderSidebarModalTitle(
        <FolderOpenOutlined />,
        renameViewTarget?.type === 'tag' ? t('sidebar.modal.tag.edit_title') : t('sidebar.modal.tag.create_title'),
        renameViewTarget?.type === 'tag' ? t('sidebar.modal.tag.edit_description') : t('sidebar.modal.tag.create_description'),
      )}
      open={isCreateTagModalOpen}
      centered
      zIndex={APP_NESTED_MODAL_Z_INDEX}
      styles={{ content: modalPanelStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 10 }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 12 } }}
      onOk={() => {
        createTagForm.validateFields().then(values => {
          const parentTagId = resolveConnectionTagParentId(
            values.parentTagId,
            connectionTags,
            editingTagId,
          );
          const requestedName = String(values.name || '').trim();
          const duplicate = connectionTags.some((tag) => (
            tag.id !== editingTagId
            && tag.parentTagId === parentTagId
            && tag.name.trim().localeCompare(requestedName, undefined, { sensitivity: 'accent' }) === 0
          ));
          if (duplicate) {
            createTagForm.setFields([{ name: 'name', errors: [t('connection.sidebar.management.nameDuplicate')] }]);
            return;
          }
          if (renameViewTarget?.type === 'tag') {
            updateConnectionTag({
              ...renameViewTarget.dataRef,
              name: values.name,
              parentTagId,
              connectionIds: values.connectionIds || [],
            });
          } else {
            const tagId = Date.now().toString();
            addConnectionTag({
              id: tagId,
              name: values.name,
              parentTagId,
              connectionIds: values.connectionIds || [],
            });
          }
          setIsCreateTagModalOpen(false);
        });
      }}
      onCancel={() => setIsCreateTagModalOpen(false)}
    >
      <Form
        form={createTagForm}
        layout="vertical"
      >
        <div style={modalSectionStyle}>
          <Form.Item name="name" label={t('sidebar.field.tag_name')} rules={[{ required: true, message: t('sidebar.validation.tag_name_required') }]}>
            <Input placeholder={t('sidebar.placeholder.tag_name')} />
          </Form.Item>
          <Form.Item name="parentTagId" label={t('sidebar.field.parent_group')}>
            <Select
              allowClear
              placeholder={t('sidebar.placeholder.parent_group')}
              getPopupContainer={(trigger) => trigger.parentElement || document.body}
              options={buildConnectionTagParentOptions(
                connectionTags,
                editingTagId,
              )}
            />
          </Form.Item>
          <Form.Item name="connectionIds" label={t('sidebar.field.select_connections')} style={{ marginBottom: 0 }}>
            <Checkbox.Group style={{ width: '100%' }}>
              <div style={modalScrollSectionStyle}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  {selectableConnections.length > 0 ? selectableConnections.map(conn => (
                    <Checkbox key={conn.id} value={conn.id}>
                      {conn.name} {conn.config.host ? `(${conn.config.host})` : ''}
                    </Checkbox>
                  )) : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={t('sidebar.modal.tag.no_available_connections')}
                    />
                  )}
                </Space>
              </div>
            </Checkbox.Group>
          </Form.Item>
        </div>
      </Form>
    </Modal>

    <Modal
      title={t('sidebar.modal.create_database.title')}
      open={isCreateDbModalOpen}
      onOk={handleCreateDatabase}
      onCancel={() => setIsCreateDbModalOpen(false)}
    >
      <Form form={createDbForm} layout="vertical">
        <Form.Item
          name="name"
          label={t('sidebar.field.database_name')}
          rules={[{ required: true, message: t('sidebar.validation.name_required') }]}
        >
          <Input {...noAutoCapInputProps} />
        </Form.Item>
        {createDatabaseCharsetSupported && (
          <>
            <Form.Item name="charset" label={t('sidebar.field.database_charset')}>
              <Select
                allowClear
                showSearch
                loading={loadingCreateDbOptions}
                placeholder={t('sidebar.placeholder.database_charset_default')}
                options={createDatabaseCharsetOptions}
                optionFilterProp="label"
              />
            </Form.Item>
            <Form.Item name="collation" label={t('sidebar.field.database_collation')}>
              <Select
                allowClear
                showSearch
                loading={loadingCreateDbOptions}
                placeholder={t('sidebar.placeholder.database_collation_default')}
                options={createDatabaseCollationOptions}
                optionFilterProp="label"
              />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>

    <Modal
      title={`${t('sidebar.v2_database_menu.new_schema')}${createSchemaTarget?.dataRef?.dbName ? ` (${createSchemaTarget.dataRef.dbName})` : ''}`}
      open={isCreateSchemaModalOpen}
      onOk={handleCreateSchema}
      onCancel={() => {
        setIsCreateSchemaModalOpen(false);
        setCreateSchemaTarget(null);
        createSchemaForm.resetFields();
      }}
    >
      <Form form={createSchemaForm} layout="vertical">
        <Form.Item name="name" label={t('sidebar.field.schema_name')} rules={[{ required: true, message: t('sidebar.validation.schema_name_required') }]}>
          <Input {...noAutoCapInputProps} />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title={renameSchemaTarget?.dataRef?.dbName && renameSchemaTarget?.dataRef?.schemaName
        ? t('sidebar.modal.rename_schema.title', { name: `${renameSchemaTarget.dataRef.dbName}.${renameSchemaTarget.dataRef.schemaName}` })
        : t('sidebar.menu.edit_schema')}
      open={isRenameSchemaModalOpen}
      onOk={handleRenameSchema}
      onCancel={() => {
        setIsRenameSchemaModalOpen(false);
        setRenameSchemaTarget(null);
        renameSchemaForm.resetFields();
      }}
    >
      <Form form={renameSchemaForm} layout="vertical">
        <Form.Item
          name="newName"
          label={t('sidebar.field.schema_name')}
          rules={[{ required: true, message: t('sidebar.validation.schema_name_required') }]}
        >
          <Input {...noAutoCapInputProps} />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title={renameDbTarget?.dataRef?.dbName ? t('sidebar.modal.rename_database.title', { name: renameDbTarget.dataRef.dbName }) : t('sidebar.menu.rename_database')}
      open={isRenameDbModalOpen}
      onOk={handleRenameDatabase}
      onCancel={() => {
        setIsRenameDbModalOpen(false);
        setRenameDbTarget(null);
        renameDbForm.resetFields();
      }}
    >
      <Form form={renameDbForm} layout="vertical">
        <Form.Item name="newName" label={t('sidebar.field.new_database_name')} rules={[{ required: true, message: t('sidebar.validation.new_database_name_required') }]}>
          <Input {...noAutoCapInputProps} />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title={renameTableTarget?.dataRef?.tableName
        ? t('sidebar.modal.rename_table.title', { name: renameTableTarget.dataRef.tableName })
        : t('sidebar.menu.rename_table')}
      open={isRenameTableModalOpen}
      onOk={handleRenameTable}
      onCancel={() => {
        setIsRenameTableModalOpen(false);
        setRenameTableTarget(null);
        renameTableForm.resetFields();
      }}
    >
      <Form form={renameTableForm} layout="vertical">
        <Form.Item
          name="newName"
          label={t('sidebar.field.new_table_name')}
          rules={[{ required: true, message: t('sidebar.validation.new_table_name_required') }]}
        >
          <Input {...noAutoCapInputProps} />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title={renameViewTarget?.dataRef?.viewName
        ? t('sidebar.modal.rename_view.title', { name: renameViewTarget.dataRef.viewName })
        : t('sidebar.menu.rename_view')}
      open={isRenameViewModalOpen}
      onOk={handleRenameView}
      onCancel={() => {
        setIsRenameViewModalOpen(false);
        setRenameViewTarget(null);
        renameViewForm.resetFields();
      }}
    >
      <Form form={renameViewForm} layout="vertical">
        <Form.Item
          name="newName"
          label={t('sidebar.field.new_view_name')}
          rules={[{ required: true, message: t('sidebar.validation.new_view_name_required') }]}
        >
          <Input {...noAutoCapInputProps} />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title={`${t('query_editor.save_modal.rename_title')}${renameSavedQueryTarget?.name ? ` (${renameSavedQueryTarget.name})` : ''}`}
      open={isRenameSavedQueryModalOpen}
      onOk={handleRenameSavedQuery}
      onCancel={() => {
        setIsRenameSavedQueryModalOpen(false);
        setRenameSavedQueryTarget(null);
        renameSavedQueryForm.resetFields();
      }}
      okText={t('query_editor.action.rename_query')}
      cancelText={t('common.cancel')}
    >
      <Form form={renameSavedQueryForm} layout="vertical">
        <Form.Item name="name" label={t('query_editor.save_modal.name_label')} rules={[{ required: true, message: t('query_editor.save_modal.name_required') }]}>
          <Input {...noAutoCapInputProps} />
        </Form.Item>
      </Form>
    </Modal>
  </>);
};
