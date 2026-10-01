import { useMemo } from 'react';
import { Button, Checkbox, Space, Tag, Tooltip } from 'antd';
import { useI18n } from '../../../i18n/provider';
import UserManagementEmpty from '../UserManagementEmpty';
import { GnShieldIcon } from '../userManagementIcons';
import type { UMGrant, UMPrivilegeDescriptor } from '../userManagementTypes';

interface PrivilegeMatrixProps {
  privileges: UMPrivilegeDescriptor[];
  target: UMGrant;
  grants: UMGrant[];
  inherited: UMGrant[];
  writable: boolean;
  supportsGrantOption: boolean;
  supportsDeny: boolean;
  onChange: (grants: UMGrant[]) => void;
}

const TARGET_FIELDS = ['scope', 'database', 'schema', 'object', 'column', 'objectType', 'node'] as const;

/** 授权目标相同（忽略权限名与选项）。 */
export const sameGrantTarget = (left: UMGrant, right: UMGrant): boolean => TARGET_FIELDS.every(
  (field) => String(left[field] || '').toUpperCase() === String(right[field] || '').toUpperCase(),
);

const samePrivilege = (grant: UMGrant, name: string) => grant.privilege.toUpperCase() === name.toUpperCase();

/** 某一授权目标上的权限勾选矩阵：授予 / 可转授 / 拒绝（SQL Server DENY）。 */
export default function PrivilegeMatrix({
  privileges,
  target,
  grants,
  inherited,
  writable,
  supportsGrantOption,
  supportsDeny,
  onChange,
}: PrivilegeMatrixProps) {
  const { t } = useI18n();
  const onTarget = useMemo(() => grants.filter((grant) => sameGrantTarget(grant, target)), [grants, target]);
  const others = useMemo(() => grants.filter((grant) => !sameGrantTarget(grant, target)), [grants, target]);

  const upsert = (name: string, patch: Partial<UMGrant> | null) => {
    const kept = onTarget.filter((grant) => !samePrivilege(grant, name));
    const current = onTarget.find((grant) => samePrivilege(grant, name));
    const next = patch === null ? kept : [...kept, { ...target, ...current, ...patch, privilege: current?.privilege || name }];
    onChange([...others, ...next]);
  };

  const setAll = (granted: boolean) => {
    const next = granted ? privileges.map((item) => onTarget.find((grant) => samePrivilege(grant, item.name)) || { ...target, privilege: item.name }) : [];
    onChange([...others, ...next]);
  };

  if (privileges.length === 0) {
    return <UserManagementEmpty compact icon={<GnShieldIcon />} text={t('user_management.privileges.none')} />;
  }

  return (
    <div className="gn-user-mgmt-matrix">
      <Space className="gn-user-mgmt-matrix-actions">
        <Button size="small" disabled={!writable} onClick={() => setAll(true)}>{t('user_management.privileges.select_all')}</Button>
        <Button size="small" disabled={!writable} onClick={() => setAll(false)}>{t('user_management.privileges.clear_all')}</Button>
      </Space>
      <div className="gn-user-mgmt-table-card"><table className="gn-user-mgmt-matrix-table">
        <thead>
          <tr>
            <th>{t('user_management.privileges.column.privilege')}</th>
            <th>{t('user_management.privileges.column.granted')}</th>
            {supportsGrantOption && <th>{t('user_management.privileges.column.grant_option')}</th>}
            {supportsDeny && <th>{t('user_management.privileges.column.deny')}</th>}
          </tr>
        </thead>
        <tbody>
          {privileges.map((item) => {
            const grant = onTarget.find((candidate) => samePrivilege(candidate, item.name));
            const via = inherited.find((candidate) => sameGrantTarget(candidate, target) && samePrivilege(candidate, item.name));
            return (
              <tr key={item.name}>
                <td>
                  <span className="gn-user-mgmt-privilege-name">{item.name}</span>
                  {item.dynamic && <Tag className="gn-user-mgmt-privilege-tag">{t('user_management.privileges.dynamic')}</Tag>}
                  {item.deprecated && <Tag color="orange" className="gn-user-mgmt-privilege-tag">{t('user_management.option.deprecated')}</Tag>}
                  {via && (
                    <Tooltip title={t('user_management.privileges.inherited', { role: via.inherited || '' })}>
                      <Tag color="purple" className="gn-user-mgmt-privilege-tag">{t('user_management.privileges.inherited_short')}</Tag>
                    </Tooltip>
                  )}
                </td>
                <td>
                  <Checkbox
                    checked={Boolean(grant) && !grant?.deny}
                    disabled={!writable}
                    aria-label={`${item.name} ${t('user_management.privileges.column.granted')}`}
                    onChange={(event) => upsert(item.name, event.target.checked ? { deny: false } : null)}
                  />
                </td>
                {supportsGrantOption && (
                  <td>
                    <Checkbox
                      checked={Boolean(grant?.withGrantOption)}
                      disabled={!writable || !grant || grant.deny}
                      aria-label={`${item.name} ${t('user_management.privileges.column.grant_option')}`}
                      onChange={(event) => upsert(item.name, { withGrantOption: event.target.checked })}
                    />
                  </td>
                )}
                {supportsDeny && (
                  <td>
                    <Checkbox
                      checked={Boolean(grant?.deny)}
                      disabled={!writable}
                      aria-label={`${item.name} ${t('user_management.privileges.column.deny')}`}
                      onChange={(event) => upsert(item.name, event.target.checked ? { deny: true, withGrantOption: false } : null)}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </div>
  );
}
