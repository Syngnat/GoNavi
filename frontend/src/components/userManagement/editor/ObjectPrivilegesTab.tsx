import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Tag, Tree } from 'antd';
import type { DataNode, EventDataNode } from 'antd/es/tree';
import { useI18n } from '../../../i18n/provider';
import { GnColumnsIcon, GnDatabaseIcon, GnFunctionIcon, GnSequenceIcon, GnTableIcon, GnViewIcon } from '../../icons/gnIcons';
import { userManagementScopeLabel } from '../userManagementFieldLabels';
import { GnChevronIcon, GnSchemaIcon } from '../userManagementIcons';
import UserManagementEmpty from '../UserManagementEmpty';
import type { PrincipalDraft } from '../userManagementDraft';
import type { UMGrant, UMServerProfile } from '../userManagementTypes';
import {
  catalogObjectsFor,
  catalogObjectTarget,
  describeTarget,
  grantedTargets,
  resolveObjectTreeLayout,
  splitQualifiedTable,
  tableTarget,
  targetFromKey,
  targetKey,
  type CatalogObject,
} from './objectPrivilegeTree';
import ManualObjectTarget from './ManualObjectTarget';
import PrivilegeMatrix from './PrivilegeMatrix';

interface ObjectPrivilegesTabProps {
  profile: UMServerProfile;
  draft: PrincipalDraft;
  inherited: UMGrant[];
  writable: boolean;
  database: string;
  databases: string[];
  loadTables: (database: string) => Promise<string[]>;
  loadColumns: (database: string, table: string) => Promise<string[]>;
  loadObjects: (database: string) => Promise<CatalogObject[]>;
  onGrantsChange: (grants: UMGrant[]) => void;
}

const scopeIcon = (scope: string) => {
  switch (scope) {
    case 'database': return <GnDatabaseIcon />;
    case 'schema': return <GnSchemaIcon />;
    case 'column': return <GnColumnsIcon />;
    case 'sequence': return <GnSequenceIcon />;
    case 'routine': return <GnFunctionIcon />;
    default: return <GnTableIcon />;
  }
};

const node = (target: UMGrant, title: string, isLeaf: boolean, icon?: ReactNode): DataNode => (
  { key: targetKey(target), title, isLeaf, icon: icon ?? scopeIcon(target.scope) }
);

/** 对象级权限：左侧对象树与已授权对象，右侧所选对象的权限矩阵。 */
export default function ObjectPrivilegesTab(props: ObjectPrivilegesTabProps) {
  const { profile, draft, inherited, writable, database, databases, loadTables, loadColumns, loadObjects, onGrantsChange } = props;
  const { t } = useI18n();
  const layout = resolveObjectTreeLayout(String(profile.family));
  const columnsEnabled = profile.objectScopes.includes('column');
  const [treeData, setTreeData] = useState<DataNode[]>([]);
  const [selectedKey, setSelectedKey] = useState('');

  useEffect(() => {
    if (layout === 'database-schema') {
      setTreeData(database ? [node({ privilege: '', scope: 'database', database }, database, false)] : []);
      return;
    }
    const scope = layout === 'schema' ? 'schema' : 'database';
    setTreeData(databases.map((name) => node(scope === 'schema' ? { privilege: '', scope, schema: name } : { privilege: '', scope, database: name }, name, false)));
  }, [database, databases, layout]);

  const objectNode = (container: string, item: CatalogObject): DataNode => {
    const icon = item.kind === 'view' ? <GnViewIcon /> : undefined;
    return node(catalogObjectTarget(layout, container, item), item.name, item.kind === 'view' ? !columnsEnabled : true, icon);
  };

  const fetchChildren = async (target: UMGrant): Promise<DataNode[]> => {
    if (target.scope === 'database' || target.scope === 'schema') {
      // 模式节点的容器：Oracle 系是模式属主本身，PG / SQL Server 是它所在的库
      const container = layout === 'schema' ? String(target.schema) : String(target.database);
      const [tables, objects] = await Promise.all([loadTables(container), loadObjects(container)]);
      const known = new Set(tables);
      const extras = objects.filter((item) => item.kind !== 'view' || !known.has(item.schema ? `${item.schema}.${item.name}` : item.name));
      if (layout === 'database-schema' && target.scope === 'database') {
        const schemas = Array.from(new Set([...tables.map((name) => splitQualifiedTable(name).schema), ...extras.map((item) => item.schema)].filter(Boolean)));
        return [
          ...schemas.map((schema) => node({ privilege: '', scope: 'schema', database: container, schema }, schema, false)),
          ...tables.filter((name) => !splitQualifiedTable(name).schema).map((name) => node(tableTarget(layout, container, name), name, !columnsEnabled)),
          ...extras.filter((item) => !item.schema).map((item) => objectNode(container, item)),
        ];
      }
      const scoped = layout === 'database-schema' ? tables.filter((name) => name.startsWith(`${target.schema}.`)) : tables;
      return [
        ...scoped.map((name) => node(tableTarget(layout, container, name), splitQualifiedTable(name).table || name, !columnsEnabled)),
        ...catalogObjectsFor(layout, extras, String(target.schema || '')).map((item) => objectNode(container, item)),
      ];
    }
    if (target.scope === 'table' && columnsEnabled) {
      const container = layout === 'schema' ? String(target.schema) : String(target.database);
      const qualified = layout === 'database-schema' && target.schema ? `${target.schema}.${target.object}` : String(target.object);
      const columns = await loadColumns(container, qualified);
      return columns.map((column) => node({ ...target, scope: 'column', column }, column, true));
    }
    return [];
  };

  const loadChildren = async (treeNode: EventDataNode<DataNode>) => {
    let children: DataNode[] = [];
    try {
      children = await fetchChildren(targetFromKey(String(treeNode.key)));
    } catch {
      children = [];
    }
    // 没有可展开的内容时收起展开箭头，避免点开一片空白
    const attach = (nodes: DataNode[]): DataNode[] => nodes.map((item) => (item.key === treeNode.key
      ? { ...item, children, isLeaf: children.length === 0 ? true : item.isLeaf }
      : { ...item, children: item.children ? attach(item.children) : item.children }));
    setTreeData((current) => attach(current));
  };

  const selected = selectedKey ? targetFromKey(selectedKey) : null;
  const privileges = useMemo(
    () => (selected ? profile.privileges.filter((item) => item.scopes.includes(selected.scope)) : []),
    [profile.privileges, selected],
  );
  const granted = grantedTargets(draft.grants);

  return (
    <div className="gn-user-mgmt-object-privileges">
      <div className="gn-user-mgmt-object-tree">
        {granted.length > 0 && (
          <div className="gn-user-mgmt-granted-targets">
            <div className="gn-user-mgmt-section-title">{t('user_management.privileges.granted_objects')}</div>
            {granted.map((target) => (
              <button key={targetKey(target)} type="button" className={`gn-user-mgmt-target-chip${targetKey(target) === selectedKey ? ' is-selected' : ''}`} onClick={() => setSelectedKey(targetKey(target))}>
                <Tag>{userManagementScopeLabel(target.scope, t)}</Tag>{describeTarget(target)}
              </button>
            ))}
          </div>
        )}
        <div className="gn-user-mgmt-tree-box">
          {treeData.length === 0 ? (
            <UserManagementEmpty compact icon={<GnDatabaseIcon />} text={t('user_management.privileges.no_objects')} />
          ) : (
            <Tree showIcon blockNode switcherIcon={<GnChevronIcon />} treeData={treeData} loadData={loadChildren} selectedKeys={selectedKey ? [selectedKey] : []} onSelect={(keys) => setSelectedKey(String(keys[0] || ''))} />
          )}
        </div>
        <ManualObjectTarget profile={profile} layout={layout} database={database} databases={databases} loadTables={loadTables} onLocate={(target) => setSelectedKey(targetKey(target))} />
      </div>
      <div className="gn-user-mgmt-object-matrix">
        {selected ? (
          <>
            <div className="gn-user-mgmt-section-title">
              <Tag color="blue">{userManagementScopeLabel(selected.scope, t)}</Tag>{describeTarget(selected)}
            </div>
            <PrivilegeMatrix
              privileges={privileges}
              target={selected}
              grants={draft.grants}
              inherited={inherited}
              writable={writable}
              supportsGrantOption={profile.features.grantOption !== false}
              supportsDeny={profile.features.deny === true}
              onChange={onGrantsChange}
            />
          </>
        ) : (
          <UserManagementEmpty icon={<GnTableIcon />} text={t('user_management.privileges.select_object')} />
        )}
      </div>
    </div>
  );
}
