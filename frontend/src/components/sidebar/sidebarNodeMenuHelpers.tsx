import { message, Input } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { t } from '../../i18n';
import { useStore } from '../../store';
import type { SavedConnection } from '../../types';
import {
  getRedisDbAlias,
  MAX_REDIS_DB_ALIAS_LENGTH,
  buildRedisDbNodeLabel,
} from '../../utils/redisDbAlias';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import { confirmProductionMutation } from '../../utils/productionRiskConfirm';
import {
  type NacosNamespaceDiscoveryMode,
  resolveNacosNamespaceDiscoveryModeFromTreeNode,
} from '../sidebarV2Utils';

type NacosNamespaceFormMode = 'create' | 'edit';

export const resolveOptionalSchemaName = (node: any): string | undefined => {
  const schemaName = String(node?.dataRef?.schemaName ?? '').trim();
  return schemaName || undefined;
};

export const isNacosNamespaceStructureRestricted = (config: SavedConnection['config'] | undefined) =>
  config?.readOnly === true || config?.protection?.restrictStructureEdit === true;

export const resolveCurrentNacosConnection = (connection: SavedConnection): SavedConnection => {
  const current = useStore.getState().connections.find((item) => item.id === connection.id);
  return current || connection;
};

export const assertNacosNamespaceStructureEditable = (connection: SavedConnection) => {
  const current = resolveCurrentNacosConnection(connection);
  if (!isNacosNamespaceStructureRestricted(current.config)) {
    return current;
  }
  const error = new Error(t('nacos.backend.error.read_only'));
  message.error(error.message);
  throw error;
};

export const resolveCurrentNacosNamespaceDiscoveryMode = (
  connectionId: unknown,
  node: any,
  resolver?: (id: string) => unknown,
): NacosNamespaceDiscoveryMode | undefined => {
  const liveMode = resolver?.(String(connectionId || ''));
  if (liveMode === 'listed' || liveMode === 'configured') {
    return liveMode;
  }
  return resolveNacosNamespaceDiscoveryModeFromTreeNode(node);
};

export const assertNacosNamespaceDiscoveryAllowsCrud = (
  isBlocked: (() => boolean) | undefined,
) => {
  if (!isBlocked?.()) return;
  const error = new Error(t('nacos.backend.error.read_only'));
  message.error(error.message);
  throw error;
};

export const openNacosNamespaceFormModal = (options: {
  mode: NacosNamespaceFormMode;
  connection: SavedConnection;
  initial?: { id?: string; showName?: string; description?: string };
  onSuccess?: () => void | Promise<void>;
  isNamespaceManagementBlocked?: () => boolean;
}) => {
  if (
    options.isNamespaceManagementBlocked?.() ||
    isNacosNamespaceStructureRestricted(
      resolveCurrentNacosConnection(options.connection).config,
    )
  ) {
    return;
  }
  const draft = {
    id: String(options.initial?.id || ''),
    showName: String(options.initial?.showName || ''),
    description: String(options.initial?.description || ''),
  };
  const isEdit = options.mode === 'edit';
  Modal.confirm({
    title: isEdit ? t('nacos.namespace.menu.edit') : t('nacos.namespace.menu.create'),
    icon: null,
    width: 480,
    content: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
        <div>
          <div style={{ marginBottom: 4 }}>{t('nacos.namespace.field.id')}</div>
          <Input
            {...noAutoCapInputProps}
            disabled={isEdit}
            defaultValue={draft.id}
            placeholder="optional"
            onChange={(event) => {
              draft.id = event.target.value;
            }}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('nacos.namespace.field.name')}</div>
          <Input
            {...noAutoCapInputProps}
            defaultValue={draft.showName}
            onChange={(event) => {
              draft.showName = event.target.value;
            }}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('nacos.namespace.field.desc')}</div>
          <Input.TextArea
            {...noAutoCapInputProps}
            rows={3}
            defaultValue={draft.description}
            onChange={(event) => {
              draft.description = event.target.value;
            }}
          />
        </div>
      </div>
    ),
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      assertNacosNamespaceDiscoveryAllowsCrud(
        options.isNamespaceManagementBlocked,
      );
      const currentConnection = assertNacosNamespaceStructureEditable(options.connection);
      const showName = draft.showName.trim();
      if (!showName) {
        message.error(t('nacos.backend.error.namespace_name_required'));
        throw new Error('namespace name required');
      }
      const rpcConfig = buildRpcConnectionConfig(currentConnection.config as any);
      if (!await confirmProductionMutation(
        currentConnection,
        t('connection.production_risk.action.modify_configuration'),
        [draft.id.trim(), showName].filter(Boolean).join(' / '),
        t,
      )) return;
      if (isEdit) {
        const res = await (window as any).go.app.App.NacosUpdateNamespace(rpcConfig, {
          id: draft.id.trim(),
          showName,
          description: draft.description.trim(),
        });
        if (!res?.success) {
          message.error(res?.message || 'update failed');
          throw new Error(res?.message || 'update failed');
        }
      } else {
        const res = await (window as any).go.app.App.NacosCreateNamespace(rpcConfig, {
          id: draft.id.trim(),
          showName,
          description: draft.description.trim(),
        });
        if (!res?.success) {
          message.error(res?.message || 'create failed');
          throw new Error(res?.message || 'create failed');
        }
      }
      await options.onSuccess?.();
      message.success(t(isEdit
        ? 'nacos.namespace.message.update_success'
        : 'nacos.namespace.message.create_success'));
    },
  });
};

const updateRedisDbNodeAlias = (
  nodes: any[],
  targetKey: string,
  title: string,
  alias: string,
): any[] =>
  nodes.map((node) => {
    if (node.key === targetKey) {
      return {
        ...node,
        title,
        dataRef: {
          ...(node.dataRef || {}),
          redisDbAlias: alias,
        },
      };
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: updateRedisDbNodeAlias(node.children, targetKey, title, alias) };
    }
    return node;
  });

export const openRedisDbAliasModal = (
  node: any,
  context: SidebarNodeMenuContext,
): void => {
  const { id, redisDB } = node.dataRef;
  const { treeDataRef, setTreeData } = context;
  const currentAlias = getRedisDbAlias(
    useStore.getState().appearance.redisDbAliases,
    id,
    redisDB,
  );
  let draft = currentAlias;
  Modal.confirm({
    title: t('redis.db_alias.modal.title', { db: `db${redisDB}` }),
    icon: null,
    content: (
      <Input
        defaultValue={currentAlias}
        maxLength={MAX_REDIS_DB_ALIAS_LENGTH}
        placeholder={t('redis.db_alias.modal.placeholder')}
        onChange={(event) => {
          draft = event.target.value;
        }}
        onPressEnter={(event) => {
          draft = (event.target as HTMLInputElement).value;
        }}
      />
    ),
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    onOk: () => {
      useStore.getState().setRedisDbAlias(id, redisDB, draft);
      if (treeDataRef?.current && typeof setTreeData === 'function') {
        const nextAlias = getRedisDbAlias(
          useStore.getState().appearance.redisDbAliases,
          id,
          redisDB,
        );
        const nextTitle = buildRedisDbNodeLabel(redisDB, nextAlias);
        const nextTree = updateRedisDbNodeAlias(treeDataRef.current, node.key, nextTitle, nextAlias);
        treeDataRef.current = nextTree;
        setTreeData(nextTree);
      }
    },
  });
};

export type TreeNode = {
  type?: string;
  title?: string;
  key?: string;
  dataRef?: any;
  children?: TreeNode[];
  [key: string]: any;
};

export type SidebarNodeMenuContext = Record<string, any>;
