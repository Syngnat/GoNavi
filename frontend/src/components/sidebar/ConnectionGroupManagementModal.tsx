import React, { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Form, Input, List, message, Select, Space, Table, Tag, Tooltip, Tree, Typography } from 'antd';
import { CloseOutlined, DeleteOutlined, EditOutlined, FolderAddOutlined, InboxOutlined, PlusOutlined, SettingOutlined, SortAscendingOutlined } from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';
import type { ColumnsType } from 'antd/es/table';
import Modal from '../common/ResizableDraggableModal';
import { useStore } from '../../store';
import type { ConnectionDisplaySortMode, ConnectionTag, SavedConnection } from '../../types';
import { t } from '../../i18n';
import { buildSidebarRootTagToken, resolveConnectionTagChildOrder, resolveSidebarRootOrderTokens } from '../../store';
import { APP_FOREGROUND_MODAL_Z_INDEX, APP_NESTED_MODAL_Z_INDEX } from '../../utils/overlayZIndex';
import { formatSidebarTableTimestamp } from './sidebarHelpers';
import './ConnectionGroupManagementModal.css';

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenTagForm: (parentTagId?: string) => void;
  onCreateConnectionInGroup: (tagId: string) => void;
  onEditConnection: (connection: SavedConnection) => void;
  onCloseTabsByConnection?: (connectionId: string) => void;
  onConnectionGroupDeleted?: () => Promise<void>;
};
const UNGROUPED = '__ungrouped__';
const CONNECTION_DRAG_TYPE = 'application/x-gonavi-connection-ids';

const isInteractiveDragTarget = (target: EventTarget | null): boolean => (
  Boolean((target as Element | null)?.closest?.('button, input, a, .ant-checkbox-wrapper, .ant-select, [role="button"]'))
);

export const hasConnectionDragPayload = (event: Pick<React.DragEvent<HTMLElement>, 'dataTransfer'>): boolean =>
  Array.from(event.dataTransfer.types).includes(CONNECTION_DRAG_TYPE);

const getConnectionIdsFromDragEvent = (event: React.DragEvent<HTMLElement>): string[] => {
  if (!hasConnectionDragPayload(event)) return [];
  try {
    const ids = JSON.parse(event.dataTransfer.getData(CONNECTION_DRAG_TYPE));
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
};

export const filterExistingConnectionIds = (
  ids: string[],
  connections: Array<Pick<SavedConnection, 'id'>>,
): string[] => {
  const existingIds = new Set(connections.map((connection) => connection.id));
  return ids.filter((id) => existingIds.has(id));
};

export const findFirstRootTagToken = (tokens: string[]): string | null =>
  tokens.find((token) => token.startsWith('tag:')) || null;

const collectTagTree = (rootId: string, tags: ConnectionTag[]) => {
  const ids = new Set<string>();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    tags.forEach((tag) => { if (tag.parentTagId === id) pending.push(tag.id); });
  }
  return tags.filter((tag) => ids.has(tag.id));
};

const ConnectionGroupManagementModal: React.FC<Props> = ({ open, onClose, onOpenTagForm, onCreateConnectionInGroup, onEditConnection, onCloseTabsByConnection, onConnectionGroupDeleted }) => {
  const connections = useStore((state) => state.connections);
  const tags = useStore((state) => state.connectionTags);
  const rootOrder = useStore((state) => state.sidebarRootOrder);
  const rootConnectionSortMode = useStore((state) => state.rootConnectionSortMode);
  const setConnectionSortMode = useStore((state) => state.setConnectionDisplaySortMode);
  const updateTag = useStore((state) => state.updateConnectionTag);
  const removeTagTree = useStore((state) => state.removeConnectionTagTree);
  const removeConnection = useStore((state) => state.removeConnection);
  const moveConnections = useStore((state) => state.moveConnectionsToTag);
  const moveTag = useStore((state) => state.moveConnectionTag);
  const [selectedContainer, setSelectedContainer] = useState<string>(UNGROUPED);
  const [selectedConnections, setSelectedConnections] = useState<string[]>([]);
  const [renameTag, setRenameTag] = useState<ConnectionTag | null>(null);
  const [nameForm] = Form.useForm<{ name: string }>();

  const connectionById = useMemo(() => new Map(connections.map((connection) => [connection.id, connection])), [connections]);
  const selectedExistingConnectionIds = filterExistingConnectionIds(selectedConnections, connections);
  useEffect(() => {
    setSelectedConnections((current) => {
      const next = filterExistingConnectionIds(current, connections);
      return next.length === current.length ? current : next;
    });
  }, [connections]);
  const ownerIds = useMemo(() => new Set(tags.flatMap((tag) => tag.connectionIds)), [tags]);
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const sortConnections = (ids: string[], mode: ConnectionDisplaySortMode) => {
    const manualIndex = new Map(ids.map((id, index) => [id, index]));
    return [...ids].sort((left, right) => {
      const a = connectionById.get(left); const b = connectionById.get(right);
      if (!a || !b) return (manualIndex.get(left) || 0) - (manualIndex.get(right) || 0);
      if (mode === 'createdAt') return (b.createdAt || 0) - (a.createdAt || 0) || (manualIndex.get(left) || 0) - (manualIndex.get(right) || 0) || left.localeCompare(right);
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || (manualIndex.get(left) || 0) - (manualIndex.get(right) || 0) || left.localeCompare(right);
    });
  };
  const moveDraggedConnections = (connectionIds: string[], targetTagId: string | null) => {
    if (!connectionIds.length) return;
    const owners = new Map<string, ConnectionTag>();
    tags.forEach((tag) => tag.connectionIds.forEach((connectionId) => {
      if (!owners.has(connectionId)) owners.set(connectionId, tag);
    }));
    const targetName = targetTagId
      ? tagById.get(targetTagId)?.name || t('connection.sidebar.management.ungrouped')
      : t('connection.sidebar.management.ungrouped');
    const preview = connectionIds.slice(0, 8);
    Modal.confirm({
      title: t('connection.sidebar.management.moveTitle'),
      content: <div>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          {t('connection.sidebar.management.movePreviewTarget', { count: connectionIds.length, name: targetName })}
        </Typography.Paragraph>
        <List
          size="small"
          dataSource={preview}
          renderItem={(connectionId) => {
            const connection = connectionById.get(connectionId);
            const source = owners.get(connectionId)?.name || t('connection.sidebar.management.ungrouped');
            return <List.Item>{t('connection.sidebar.management.movePreviewItem', { name: connection?.name || connectionId, source })}</List.Item>;
          }}
        />
        {connectionIds.length > preview.length && <Typography.Text type="secondary">
          {t('connection.sidebar.management.movePreviewRemaining', { count: connectionIds.length - preview.length })}
        </Typography.Text>}
      </div>,
      onOk: () => moveConnections(connectionIds, targetTagId),
    });
  };
  const getConnectionDropHandlers = (targetTagId: string | null) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!hasConnectionDragPayload(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const ids = getConnectionIdsFromDragEvent(event);
      if (!ids.length) return;
      event.preventDefault();
      event.stopPropagation();
      moveDraggedConnections(ids, targetTagId);
    },
  });
  const isTagDraggable = (tag: ConnectionTag | undefined) => Boolean(tag);
  const buildTree = (parentId?: string): DataNode[] => {
    const ids = parentId ? resolveConnectionTagChildOrder(parentId, tags) : resolveSidebarRootOrderTokens(rootOrder, tags, connections);
    const tagIds = ids.filter((token) => token.startsWith('tag:')).map((token) => token.slice(4));
    return tagIds.reduce<DataNode[]>((nodes, tagId) => {
        const tag = tagById.get(tagId);
        if (!tag || (tag.parentTagId || undefined) !== parentId) return nodes;
        nodes.push({
          key: tag.id,
          title: <div className="connection-group-tree-title" {...getConnectionDropHandlers(tag.id)}><span className="connection-group-tree-name" title={tag.name}>{tag.name}</span><Typography.Text className="connection-group-tree-count" type="secondary">{tag.connectionIds.length}</Typography.Text></div>,
          children: buildTree(tag.id),
        });
        return nodes;
    }, []);
  };
  const ungrouped = connections.filter((connection) => !ownerIds.has(connection.id));
  const currentTag = selectedContainer === UNGROUPED ? undefined : tags.find((tag) => tag.id === selectedContainer);
  const currentIds = currentTag ? currentTag.connectionIds : ungrouped.map((connection) => connection.id);
  const currentMode = currentTag?.connectionSortMode || rootConnectionSortMode;
  const visibleConnections = sortConnections(currentIds, currentMode);
  const treeData: DataNode[] = [{ key: UNGROUPED, title: <div className="connection-group-tree-title" {...getConnectionDropHandlers(null)}><span className="connection-group-tree-name"><InboxOutlined /> {t('connection.sidebar.management.ungrouped')}</span><Typography.Text className="connection-group-tree-count" type="secondary">{ungrouped.length}</Typography.Text></div> }, ...buildTree()];
  const submitRename = async () => {
    const { name: rawName } = await nameForm.validateFields();
    const name = rawName.trim();
    if (!renameTag) return;
    const duplicate = tags.some((tag) => tag.id !== renameTag.id && tag.parentTagId === renameTag.parentTagId && tag.name.trim().localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
    if (duplicate) { nameForm.setFields([{ name: 'name', errors: [t('connection.sidebar.management.nameDuplicate')] }]); return; }
    updateTag({ ...renameTag, name }); setRenameTag(null);
  };
  const deleteGroup = () => {
    if (!currentTag) return;
    const subtree = collectTagTree(currentTag.id, tags);
    const connectionIds = Array.from(new Set(subtree.flatMap((tag) => tag.connectionIds)));
    const deleteContentKey = connectionIds.length > 0
      ? 'connection.sidebar.management.deleteContent'
      : 'connection.sidebar.management.deleteEmptyContent';
    Modal.confirm({
      title: t('connection.sidebar.management.deleteGroup'),
      content: t(deleteContentKey, { name: currentTag.name, connectionCount: connectionIds.length }),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const backendApp = (window as any).go?.app?.App;
          let idsToDelete = connectionIds;
          let usedAtomicGroupDelete = false;
          // If the backend can provide the authoritative layout, refuse to use
          // a stale window's subtree. This avoids deleting a connection that
          // another window moved out of the group after this modal rendered.
          if (typeof backendApp?.LoadConnectionSidebarLayout === 'function') {
            const authoritative = await backendApp.LoadConnectionSidebarLayout();
            if (authoritative?.initialized && Array.isArray(authoritative.connectionTags)) {
              const authoritativeTag = authoritative.connectionTags.find((tag: ConnectionTag) => tag.id === currentTag.id);
              if (!authoritativeTag) throw new Error(t('connection.sidebar.management.deleteStale'));
              const authoritativeSubtree = collectTagTree(currentTag.id, authoritative.connectionTags as ConnectionTag[]);
              const authoritativeIds = Array.from(new Set(authoritativeSubtree.flatMap((tag) => tag.connectionIds)));
              const localSet = new Set(connectionIds);
              const remoteSet = new Set(authoritativeIds);
              const sameIds = localSet.size === remoteSet.size && Array.from(localSet).every((id) => remoteSet.has(id));
              if (!sameIds) throw new Error(t('connection.sidebar.management.deleteStale'));
              idsToDelete = authoritativeIds;

              // New runtimes delete the complete subtree, credentials and
              // layout in one recoverable backend transaction. Keep the
              // legacy connection-only path for older already-installed
              // runtimes that do not expose this binding yet.
              if (typeof backendApp?.DeleteConnectionGroup === 'function') {
                const revision = Number(authoritative.revision);
                if (!Number.isSafeInteger(revision) || revision <= 0) {
                  throw new Error(t('connection.sidebar.management.deleteFailure'));
                }
                await backendApp.DeleteConnectionGroup({
                  tagId: currentTag.id,
                  expectedRevision: revision,
                });
                usedAtomicGroupDelete = true;
                // Advance the coordinator revision before local mutations so
                // its debounced save cannot race the committed backend
                // revision. Refresh failure is non-fatal: local cleanup below
                // still reflects the successful backend deletion.
                try {
                  await onConnectionGroupDeleted?.();
                } catch {
                  // Keep the successful deletion result and clean up locally.
                }
              }
            }
          }
          if (!usedAtomicGroupDelete && idsToDelete.length > 0 && typeof backendApp?.DeleteConnections !== 'function') {
            throw new Error(t('connection.sidebar.management.deleteFailure'));
          }
          if (!usedAtomicGroupDelete && idsToDelete.length > 0) await backendApp.DeleteConnections(idsToDelete);
          idsToDelete.forEach((connectionId) => {
            onCloseTabsByConnection?.(connectionId);
            removeConnection(connectionId);
          });
          removeTagTree(currentTag.id);
          setSelectedConnections((current) => current.filter((id) => !idsToDelete.includes(id)));
          setSelectedContainer(UNGROUPED);
        } catch (error: any) {
          const staleMessage = t('connection.sidebar.management.deleteStale');
          const errorMessage = error?.message === staleMessage
            ? staleMessage
            : t('connection.sidebar.management.deleteFailure');
          message.error(errorMessage);
          throw error;
        }
      },
    });
  };
  const handleTreeDrop = (info: any) => {
    if (!info.dropToGap || !info.dragNode || !info.node) return;
    const sourceId = String(info.dragNode.key); const targetId = String(info.node.key);
    const source = tagById.get(sourceId);
    if (!source || !isTagDraggable(source)) return;
    // The ungrouped node is synthetic. Dropping a root group directly below it
    // means placing it before the first real root group.
    if (targetId === UNGROUPED && !source.parentTagId && info.dropPosition > 0) {
      const firstRootTagToken = findFirstRootTagToken(
        resolveSidebarRootOrderTokens(rootOrder, tags, connections),
      );
      moveTag(sourceId, null, firstRootTagToken, true);
      return;
    }
    const target = tagById.get(targetId);
    if (!target || source.parentTagId !== target.parentTagId) return;
    moveTag(sourceId, source.parentTagId || null, buildSidebarRootTagToken(targetId), info.dropPosition < 0);
  };
  const visibleConnectionSet = new Set(visibleConnections);
  const connectionColumns: ColumnsType<SavedConnection> = [
    {
      title: t('connection.sidebar.management.connectionName'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string) => <Typography.Text ellipsis={{ tooltip: name }} className="connection-group-management-cell-text">{name}</Typography.Text>,
    },
    {
      title: t('connection.sidebar.management.address'),
      key: 'address',
      width: 180,
      ellipsis: true,
      render: (_, connection) => {
        const host = String(connection.config.host || '');
        const port = Number(connection.config.port);
        const address = host && Number.isFinite(port) && port > 0 ? `${host}:${port}` : host;
        return <Typography.Text ellipsis={{ tooltip: address }}>{address || '-'}</Typography.Text>;
      },
    },
    {
      title: t('connection.sidebar.management.createdAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (createdAt: number | undefined) => createdAt ? formatSidebarTableTimestamp(createdAt) : '-',
    },
    {
      title: t('connection.sidebar.management.actions'),
      key: 'actions',
      width: 80,
      align: 'center',
      render: (_, connection) => <Space size={4} className="connection-group-management-row-actions">
        <Tooltip title={t('connection.sidebar.management.editConnection')} placement="bottom" mouseEnterDelay={0.35}><Button type="text" size="small" icon={<EditOutlined />} aria-label={t('connection.sidebar.management.editConnection')} onClick={() => onEditConnection(connection)} /></Tooltip>
        <Tooltip title={t('connection.sidebar.management.deleteConnection')} placement="bottom" mouseEnterDelay={0.35}><Button className="connection-group-management-row-delete" type="default" size="small" danger icon={<DeleteOutlined />} aria-label={t('connection.sidebar.management.deleteConnection')} onClick={() => window.dispatchEvent(new CustomEvent('gonavi:delete-connection', { detail: { connectionId: connection.id } }))} /></Tooltip>
      </Space>,
    },
  ];

  return <>
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={980}
      centered
      resizable
      minResizableWidth={860}
      minResizableHeight={520}
      rootClassName="connection-group-management-modal"
      zIndex={APP_FOREGROUND_MODAL_Z_INDEX}
      title={<Space><SettingOutlined />{t('connection.sidebar.management.title')}</Space>}
      closeIcon={<Tooltip title={t('connection.sidebar.management.close')} placement="bottom" mouseEnterDelay={0.35}><CloseOutlined aria-label={t('connection.sidebar.management.close')} /></Tooltip>}
      destroyOnClose
    >
      <div className="connection-group-management-layout">
        <aside className="connection-group-management-sidebar">
          <Tooltip title={t('connection.sidebar.management.new')} placement="bottom" mouseEnterDelay={0.35}>
            <Button className="connection-group-management-new-group" type="primary" block icon={<FolderAddOutlined />} onClick={() => onOpenTagForm(selectedContainer === UNGROUPED ? undefined : selectedContainer)}>{t('connection.sidebar.management.new')}</Button>
          </Tooltip>
          <Tree className="connection-group-management-tree" treeData={treeData} selectedKeys={[selectedContainer]} defaultExpandAll blockNode draggable={{ nodeDraggable: (node) => isTagDraggable(tagById.get(String(node.key))) }} onDrop={handleTreeDrop} onSelect={(keys) => { if (keys[0]) setSelectedContainer(String(keys[0])); }} />
        </aside>
        <section className="connection-group-management-content">
          <div className="connection-group-management-toolbar">
            <div className="connection-group-management-heading">
              <Typography.Title level={5} ellipsis={{ tooltip: currentTag?.name || t('connection.sidebar.management.ungrouped') }} className="connection-group-management-title">{currentTag?.name || t('connection.sidebar.management.ungrouped')}</Typography.Title>
              {selectedExistingConnectionIds.length > 0 && <Tag className="connection-group-management-selected-tag" color="success">{t('connection.sidebar.management.selected', { count: selectedExistingConnectionIds.length })}</Tag>}
            </div>
            <Space size={6} className="connection-group-management-toolbar-actions">
              {currentTag && <>
                <Tooltip title={t('connection.sidebar.management.addConnection')} placement="bottom" mouseEnterDelay={0.35}><Button className="connection-group-management-toolbar-button is-primary" type="primary" icon={<PlusOutlined />} aria-label={t('connection.sidebar.management.addConnection')} onClick={() => onCreateConnectionInGroup(currentTag.id)} /></Tooltip>
                <Tooltip title={t('connection.sidebar.management.rename')} placement="bottom" mouseEnterDelay={0.35}><Button className="connection-group-management-toolbar-button" icon={<EditOutlined />} aria-label={t('connection.sidebar.management.rename')} onClick={() => { setRenameTag(currentTag); nameForm.setFieldsValue({ name: currentTag.name }); }} /></Tooltip>
                <Tooltip title={t('connection.sidebar.management.delete')} placement="bottom" mouseEnterDelay={0.35}><Button className="connection-group-management-toolbar-button" danger icon={<DeleteOutlined />} aria-label={t('connection.sidebar.management.delete')} onClick={deleteGroup} /></Tooltip>
              </>}
              <div className="connection-group-management-sort-control" role="group" aria-label={t('connection.sidebar.management.sort')}>
                <Tooltip title={t('connection.sidebar.management.sort')} placement="bottom" mouseEnterDelay={0.35}>
                  <span className="connection-group-management-sort-label" tabIndex={0}>
                    <SortAscendingOutlined aria-hidden="true" />
                    <span>{t('connection.sidebar.management.sortLabel')}</span>
                  </span>
                </Tooltip>
                <Select aria-label={t('connection.sidebar.management.sort')} size="small" value={currentMode} className="connection-group-management-sort" options={[{ label: t('connection.sidebar.management.name'), value: 'name' }, { label: t('connection.sidebar.management.createdAt'), value: 'createdAt' }]} onChange={(value) => setConnectionSortMode(currentTag?.id || null, value as ConnectionDisplaySortMode)} />
              </div>
            </Space>
          </div>
          {visibleConnections.length ? <Table<SavedConnection>
            className="connection-group-management-table"
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={visibleConnections.map((id) => connectionById.get(id)).filter((connection): connection is SavedConnection => Boolean(connection))}
            columns={connectionColumns}
            rowSelection={{
              selectedRowKeys: selectedExistingConnectionIds,
              preserveSelectedRowKeys: true,
              columnWidth: 42,
              onChange: (keys) => setSelectedConnections((current) => Array.from(new Set([
                ...current.filter((id) => !visibleConnectionSet.has(id)),
                ...keys.map(String),
              ]))),
            }}
            onRow={(connection) => ({
              draggable: true,
              onDragStart: (event) => {
                if (isInteractiveDragTarget(event.target)) {
                  event.preventDefault();
                  return;
                }
                const ids = selectedExistingConnectionIds.includes(connection.id) ? selectedExistingConnectionIds : [connection.id];
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(CONNECTION_DRAG_TYPE, JSON.stringify(ids));
              },
            })}
          /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('connection.sidebar.management.empty')} />}
        </section>
      </div>
    </Modal>
    <Modal zIndex={APP_NESTED_MODAL_Z_INDEX} centered open={Boolean(renameTag)} title={t('connection.sidebar.management.rename')} onCancel={() => setRenameTag(null)} onOk={() => { void submitRename(); }} destroyOnClose><Form form={nameForm} layout="vertical"><Form.Item name="name" label={t('connection.sidebar.management.nameLabel')} rules={[{ required: true, whitespace: true, message: t('connection.sidebar.management.nameRequired') }]}><Input autoFocus /></Form.Item></Form></Modal>
  </>;
};

export default ConnectionGroupManagementModal;
