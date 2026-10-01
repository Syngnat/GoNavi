import { useEffect, useMemo, useState } from 'react';
import { AutoComplete, Button, Select } from 'antd';
import { useI18n } from '../../../i18n/provider';
import { GnPlusIcon } from '../../icons/gnIcons';
import { userManagementScopeLabel } from '../userManagementFieldLabels';
import type { UMGrant, UMServerProfile } from '../userManagementTypes';
import {
  buildManualTarget,
  manualTargetNeedsObject,
  splitQualifiedTable,
  type ObjectTreeLayout,
} from './objectPrivilegeTree';

interface ManualObjectTargetProps {
  profile: UMServerProfile;
  layout: ObjectTreeLayout;
  /** 顶部选中的库；PG / SQL Server 授权按库存放，只能在该库内选择。 */
  database: string;
  databases: string[];
  loadTables: (database: string) => Promise<string[]>;
  onLocate: (target: UMGrant) => void;
}

const ROUTINE_TYPES = ['PROCEDURE', 'FUNCTION'];

/** 手动指定树里没有的对象（函数、序列等）：库 / 模式从已有清单中选择，表名给出联想。 */
export default function ManualObjectTarget({ profile, layout, database, databases, loadTables, onLocate }: ManualObjectTargetProps) {
  const { t } = useI18n();
  const scopes = useMemo(() => profile.objectScopes.filter((scope) => scope !== 'column'), [profile.objectScopes]);
  // 树里能浏览到库 / 模式 / 表，手动入口主要补函数、序列等，默认落在这类层级上
  const [scope, setScope] = useState(scopes.find((item) => item === 'routine' || item === 'sequence') || scopes[0] || 'table');
  const [container, setContainer] = useState('');
  const [object, setObject] = useState('');
  const [objectType, setObjectType] = useState<string | undefined>();
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const containerScope = layout === 'schema' ? 'schema' : 'database';
  const containerOptions = useMemo(
    () => (layout === 'database-schema' ? (database ? [database] : []) : databases).map((name) => ({ value: name, label: name })),
    [database, databases, layout],
  );
  const effectiveContainer = layout === 'database-schema' ? database : container;
  const needsObject = manualTargetNeedsObject(layout, scope);
  const suggestSchemas = layout === 'database-schema' && scope === 'schema';
  const suggestTables = scope === 'table';

  useEffect(() => {
    setObject('');
    setObjectType(undefined);
  }, [scope]);

  useEffect(() => {
    if (!effectiveContainer || !needsObject || !(suggestTables || suggestSchemas)) {
      setSuggestions([]);
      return undefined;
    }
    let alive = true;
    loadTables(effectiveContainer).then((names) => {
      if (!alive) return;
      setSuggestions(suggestSchemas
        ? Array.from(new Set(names.map((name) => splitQualifiedTable(name).schema).filter(Boolean)))
        : names);
    }).catch(() => {
      if (alive) setSuggestions([]);
    });
    return () => { alive = false; };
  }, [effectiveContainer, loadTables, needsObject, suggestSchemas, suggestTables]);

  const target = buildManualTarget(layout, {
    scope,
    container: effectiveContainer,
    object,
    objectType: scope === 'routine' ? objectType : undefined,
  });
  const ready = target !== null && (scope !== 'routine' || Boolean(objectType));
  const scopeLabel = userManagementScopeLabel(scope, t);

  return (
    <div className="gn-user-mgmt-manual-target">
      <div className="gn-user-mgmt-section-title">{t('user_management.privileges.manual_title')}</div>
      <Select
        value={scope}
        aria-label={scopeLabel}
        options={scopes.map((item) => ({ value: item, label: userManagementScopeLabel(item, t) }))}
        onChange={setScope}
      />
      <Select
        showSearch
        optionFilterProp="label"
        value={effectiveContainer || undefined}
        placeholder={userManagementScopeLabel(containerScope, t)}
        aria-label={userManagementScopeLabel(containerScope, t)}
        options={containerOptions}
        disabled={layout === 'database-schema' && containerOptions.length <= 1}
        onChange={setContainer}
      />
      {needsObject && (
        <AutoComplete
          allowClear
          value={object}
          placeholder={scopeLabel}
          aria-label={scopeLabel}
          options={suggestions.map((name) => ({ value: name }))}
          filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
          onChange={setObject}
        />
      )}
      {scope === 'routine' && (
        <Select
          value={objectType}
          placeholder={t('user_management.privileges.routine_type')}
          aria-label={t('user_management.privileges.routine_type')}
          options={ROUTINE_TYPES.map((value) => ({ value, label: value }))}
          onChange={setObjectType}
        />
      )}
      <Button block icon={<GnPlusIcon />} disabled={!ready} onClick={() => target && onLocate(target)}>
        {t('user_management.privileges.manual_add')}
      </Button>
    </div>
  );
}
