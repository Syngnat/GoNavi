import { useI18n } from '../../../i18n/provider';
import type { PrincipalDraft } from '../userManagementDraft';
import type { UMGrant, UMServerProfile } from '../userManagementTypes';
import OptionsForm from './OptionsForm';
import PrivilegeMatrix from './PrivilegeMatrix';

interface ServerPrivilegesTabProps {
  profile: UMServerProfile;
  draft: PrincipalDraft;
  inherited: UMGrant[];
  writable: boolean;
  onOptionChange: (id: string, value: string) => void;
  onGrantsChange: (grants: UMGrant[]) => void;
}

const GLOBAL_TARGET: UMGrant = { privilege: '', scope: 'global' };

/** 服务器/全局权限页：角色属性开关（PG SUPERUSER 等）+ 全局权限矩阵。 */
export default function ServerPrivilegesTab({ profile, draft, inherited, writable, onOptionChange, onGrantsChange }: ServerPrivilegesTabProps) {
  const { t } = useI18n();
  const privileges = profile.privileges.filter((item) => item.scopes.includes('global'));
  return (
    <div className="gn-user-mgmt-tab-body">
      <OptionsForm profile={profile} draft={draft} tab="server-privileges" writable={writable} onChange={onOptionChange} />
      {privileges.length > 0 && (
        <>
          <div className="gn-user-mgmt-section-title">{t('user_management.privileges.global_title')}</div>
          <PrivilegeMatrix
            privileges={privileges}
            target={GLOBAL_TARGET}
            grants={draft.grants}
            inherited={inherited}
            writable={writable}
            supportsGrantOption={profile.features.grantOption !== false}
            supportsDeny={profile.features.deny === true}
            onChange={onGrantsChange}
          />
        </>
      )}
    </div>
  );
}
