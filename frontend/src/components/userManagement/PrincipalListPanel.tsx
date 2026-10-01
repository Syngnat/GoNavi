import { useMemo, useState } from 'react';
import { Button, Checkbox, Dropdown, Input, Segmented, Spin, Tag, Tooltip } from 'antd';
import { useI18n } from '../../i18n/provider';
import { GnExportIcon, GnPlusIcon, GnSearchIcon, GnTrashIcon } from '../icons/gnIcons';
import UserManagementEmpty from './UserManagementEmpty';
import { GnCrownIcon, GnLockIcon, GnShieldIcon, GnUserIcon, GnUsersIcon } from './userManagementIcons';
import { userManagementKindLabel } from './userManagementFieldLabels';
import { principalDisplayName, principalKey } from './userManagementModel';
import type { PrincipalKind, PrincipalRef, UMPrincipal, UMServerProfile } from './userManagementTypes';

interface PrincipalListPanelProps {
  profile: UMServerProfile | null;
  principals: UMPrincipal[];
  loading: boolean;
  selectedRef: PrincipalRef | null;
  creating: boolean;
  writable: boolean;
  onSelect: (ref: PrincipalRef) => void;
  onCreate: (kind: PrincipalKind) => void;
  onDrop: (principal: UMPrincipal) => void;
  onExport: (principal: UMPrincipal) => void;
}

type KindFilter = 'all' | PrincipalKind;

const kindIcon = (kind: PrincipalKind) => (kind === 'role' ? <GnUsersIcon /> : kind === 'login' ? <GnShieldIcon /> : <GnUserIcon />);

/** 左侧主体列表：搜索、类型筛选、系统账户开关、状态标记与增删导出入口。 */
export default function PrincipalListPanel({
  profile,
  principals,
  loading,
  selectedRef,
  creating,
  writable,
  onSelect,
  onCreate,
  onDrop,
  onExport,
}: PrincipalListPanelProps) {
  const { t } = useI18n();
  const [keyword, setKeyword] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [showSystem, setShowSystem] = useState(false);
  const selectedKey = selectedRef ? principalKey(selectedRef) : '';
  const kinds = profile?.kinds ?? [];
  const creatableKinds = kinds.filter((kind) => kind.creatable);
  const selected = principals.find((item) => principalKey(item.ref) === selectedKey) || null;

  const visible = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    return principals.filter((item) => (showSystem || !item.system)
      && (kindFilter === 'all' || item.ref.kind === kindFilter)
      && (!normalized || principalDisplayName(item.ref).toLowerCase().includes(normalized)));
  }, [keyword, kindFilter, principals, showSystem]);

  const kindLabel = (kind: PrincipalKind) => userManagementKindLabel(kind, t);

  return (
    <div className="gn-user-mgmt-list">
      <div className="gn-user-mgmt-list-toolbar">
        <Dropdown
          disabled={!writable || creatableKinds.length === 0}
          menu={{
            items: creatableKinds.map((kind) => ({ key: kind.kind, icon: kindIcon(kind.kind), label: t('user_management.action.new_kind', { kind: kindLabel(kind.kind) }) })),
            onClick: ({ key }) => onCreate(key as PrincipalKind),
          }}
        >
          <Button type="primary" icon={<GnPlusIcon />}>{t('user_management.action.new')}</Button>
        </Dropdown>
        <Tooltip title={t('user_management.action.export_ddl')}>
          <Button icon={<GnExportIcon />} disabled={!selected} onClick={() => selected && onExport(selected)} aria-label={t('user_management.action.export_ddl')} />
        </Tooltip>
        <Tooltip title={t('user_management.action.drop')}>
          <Button danger icon={<GnTrashIcon />} disabled={!writable || !selected || selected.system || selected.readOnly} onClick={() => selected && onDrop(selected)} aria-label={t('user_management.action.drop')} />
        </Tooltip>
      </div>
      <Input
        allowClear
        prefix={<GnSearchIcon />}
        placeholder={t('user_management.list.search')}
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
      />
      {kinds.length > 1 && (
        <Segmented
          size="small"
          block
          value={kindFilter}
          onChange={(value) => setKindFilter(value as KindFilter)}
          options={[{ value: 'all', label: t('user_management.list.all') }, ...kinds.map((kind) => ({ value: kind.kind, label: kindLabel(kind.kind) }))]}
        />
      )}
      <Checkbox checked={showSystem} onChange={(event) => setShowSystem(event.target.checked)}>
        {t('user_management.list.show_system')}
      </Checkbox>
      <div className="gn-user-mgmt-list-items" role="listbox" aria-label={t('user_management.list.aria')}>
        {loading && principals.length === 0 ? <Spin /> : null}
        {!loading && visible.length === 0 ? <UserManagementEmpty compact icon={<GnSearchIcon />} text={t('user_management.list.empty')} /> : null}
        {creating && (
          <div className="gn-user-mgmt-list-item is-selected is-creating" role="option" aria-selected="true">
            <span className="gn-user-mgmt-list-icon is-creating"><GnPlusIcon /></span>
            <span className="gn-user-mgmt-list-name">{t('user_management.list.creating')}</span>
          </div>
        )}
        {visible.map((item) => {
          const key = principalKey(item.ref);
          return (
            <div
              key={key}
              role="option"
              tabIndex={0}
              aria-selected={key === selectedKey && !creating}
              className={['gn-user-mgmt-list-item', key === selectedKey && !creating ? 'is-selected' : '', item.system ? 'is-system' : ''].filter(Boolean).join(' ')}
              onClick={() => onSelect(item.ref)}
              onKeyDown={(event) => { if (event.key === 'Enter') onSelect(item.ref); }}
            >
              <span className={`gn-user-mgmt-list-icon is-${item.ref.kind}`}>{kindIcon(item.ref.kind)}</span>
              <span className="gn-user-mgmt-list-name" title={principalDisplayName(item.ref)}>{principalDisplayName(item.ref)}</span>
              <span className="gn-user-mgmt-list-tags">
                {item.current && <Tag className="gn-user-mgmt-current-tag">{t('user_management.tag.current')}</Tag>}
                {item.superuser && <Tooltip title={t('user_management.tag.superuser')}><GnCrownIcon className="gn-user-mgmt-tag-icon is-super" /></Tooltip>}
                {item.locked && <Tooltip title={t('user_management.tag.locked')}><GnLockIcon className="gn-user-mgmt-tag-icon is-locked" /></Tooltip>}
                {item.expired && <Tag color="orange">{t('user_management.tag.expired')}</Tag>}
                {item.readOnly && <Tag>{t('user_management.tag.read_only')}</Tag>}
                {item.tags.includes('orphan') && <Tag color="red">{t('user_management.tag.orphan')}</Tag>}
                {item.tags.includes('drift') && <Tag color="red">{t('user_management.tag.drift')}</Tag>}
                {item.system && <Tag>{t('user_management.tag.system')}</Tag>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
