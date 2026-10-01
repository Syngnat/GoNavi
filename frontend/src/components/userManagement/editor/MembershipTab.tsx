import { useMemo, useState } from 'react';
import { Checkbox, Input, Tag } from 'antd';
import { useI18n } from '../../../i18n/provider';
import { GnSearchIcon } from '../../icons/gnIcons';
import UserManagementEmpty from '../UserManagementEmpty';
import { GnUsersIcon } from '../userManagementIcons';
import { principalDisplayName, roleKey } from '../userManagementModel';
import type { PrincipalDraft } from '../userManagementDraft';
import type { PrincipalRef, UMMembership, UMPrincipal, UMServerProfile } from '../userManagementTypes';

interface MembershipTabProps {
  profile: UMServerProfile;
  draft: PrincipalDraft;
  principals: UMPrincipal[];
  members: PrincipalRef[];
  writable: boolean;
  onMembershipsChange: (memberOf: UMMembership[]) => void;
  onOptionChange: (id: string, value: string) => void;
}

const sameRole = (left: PrincipalRef, right: PrincipalRef) => left.name === right.name
  && (left.host || '') === (right.host || '') && (left.database || '') === (right.database || '');

/** 可分配角色：列表中的角色 + 后端声明的内置角色；按库匹配时（SQL Server）只取同库角色。 */
const assignableRoles = (profile: UMServerProfile, principals: UMPrincipal[], draft: PrincipalDraft): PrincipalRef[] => {
  const roles: PrincipalRef[] = [];
  [...principals.filter((item) => item.ref.kind === 'role').map((item) => item.ref), ...profile.assignableRoles].forEach((ref) => {
    if (profile.features.rolesMatchDatabase && (ref.database || '') !== draft.database) return;
    if (ref.name === draft.name && (ref.host || '') === draft.host && draft.kind === 'role') return;
    if (!roles.some((item) => sameRole(item, ref))) roles.push({ ...ref, kind: 'role' });
  });
  return roles;
};

/** 成员关系：所属角色、ADMIN OPTION、PG16 INHERIT/SET、默认角色；角色页附带成员清单。 */
export default function MembershipTab({ profile, draft, principals, members, writable, onMembershipsChange, onOptionChange }: MembershipTabProps) {
  const { t } = useI18n();
  const [keyword, setKeyword] = useState('');
  const roles = useMemo(() => assignableRoles(profile, principals, draft), [draft, principals, profile]);
  const visible = roles.filter((role) => !keyword || principalDisplayName(role).toLowerCase().includes(keyword.toLowerCase()));
  const defaultRolesOption = profile.options.find((option) => option.id === 'defaultRoles' && option.kinds.includes(draft.kind));
  const defaultKeys = (draft.options.defaultRoles || '').split('\n').filter(Boolean);
  const showMembershipFlags = profile.features.membershipOptions === true;

  const membershipOf = (role: PrincipalRef) => draft.memberOf.find((item) => sameRole(item.role, role));
  const patch = (role: PrincipalRef, next: Partial<UMMembership> | null) => {
    const others = draft.memberOf.filter((item) => !sameRole(item.role, role));
    if (next === null) {
      onMembershipsChange(others);
      if (defaultKeys.includes(roleKey(role))) onOptionChange('defaultRoles', defaultKeys.filter((key) => key !== roleKey(role)).join('\n'));
      return;
    }
    onMembershipsChange([...others, { ...membershipOf(role), ...next, role }]);
  };
  const toggleDefault = (role: PrincipalRef, checked: boolean) => {
    const key = roleKey(role);
    const keys = profile.features.singleDefaultRole ? (checked ? [key] : []) : (checked ? [...defaultKeys, key] : defaultKeys.filter((item) => item !== key));
    onOptionChange('defaultRoles', keys.join('\n'));
  };

  return (
    <div className="gn-user-mgmt-tab-body">
      <Input allowClear prefix={<GnSearchIcon />} placeholder={t('user_management.membership.search')} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
      {visible.length === 0 ? <UserManagementEmpty compact icon={<GnUsersIcon />} text={t('user_management.membership.empty')} /> : (
        <div className="gn-user-mgmt-table-card"><table className="gn-user-mgmt-matrix-table">
          <thead>
            <tr>
              <th>{t('user_management.membership.column.role')}</th>
              <th>{t('user_management.membership.column.member')}</th>
              {profile.features.adminOption !== false && <th>{t('user_management.membership.column.admin')}</th>}
              {showMembershipFlags && <th>{t('user_management.membership.column.inherit')}</th>}
              {showMembershipFlags && <th>{t('user_management.membership.column.set')}</th>}
              {defaultRolesOption && <th>{t('user_management.membership.column.default')}</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((role) => {
              const membership = membershipOf(role);
              return (
                <tr key={principalDisplayName(role)}>
                  <td>{principalDisplayName(role)}</td>
                  <td><Checkbox checked={Boolean(membership)} disabled={!writable} aria-label={principalDisplayName(role)} onChange={(event) => patch(role, event.target.checked ? {} : null)} /></td>
                  {profile.features.adminOption !== false && <td><Checkbox checked={Boolean(membership?.adminOption)} disabled={!writable || !membership} onChange={(event) => patch(role, { adminOption: event.target.checked })} /></td>}
                  {showMembershipFlags && <td><Checkbox checked={membership?.inherit !== false} disabled={!writable || !membership} onChange={(event) => patch(role, { inherit: event.target.checked })} /></td>}
                  {showMembershipFlags && <td><Checkbox checked={membership?.set !== false} disabled={!writable || !membership} onChange={(event) => patch(role, { set: event.target.checked })} /></td>}
                  {defaultRolesOption && <td><Checkbox checked={defaultKeys.includes(roleKey(role))} disabled={!writable || !membership} onChange={(event) => toggleDefault(role, event.target.checked)} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {draft.kind === 'role' && members.length > 0 && (
        <div className="gn-user-mgmt-members">
          <div className="gn-user-mgmt-section-title">{t('user_management.membership.members_title', { count: members.length })}</div>
          {members.map((member) => <Tag key={principalDisplayName(member)}>{principalDisplayName(member)}</Tag>)}
        </div>
      )}
    </div>
  );
}
