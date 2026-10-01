import { AutoComplete, Input, Select } from 'antd';
import { useI18n } from '../../../i18n/provider';
import type { PasswordDraft, PrincipalDraft } from '../userManagementDraft';
import type { UMServerProfile } from '../userManagementTypes';
import OptionsForm from './OptionsForm';
import PasswordSection from './PasswordSection';

interface GeneralTabProps {
  profile: UMServerProfile;
  draft: PrincipalDraft;
  writable: boolean;
  /** 已有库清单；为空时（未加载 / 加载失败）退化为手输。 */
  databases: string[];
  onIdentityChange: (patch: Partial<Pick<PrincipalDraft, 'name' | 'host' | 'database'>>) => void;
  onPasswordChange: (patch: Partial<PasswordDraft>) => void;
  onOptionChange: (id: string, value: string) => void;
}

const HOST_PRESETS = ['%', 'localhost', '127.0.0.1', '::1', '10.%', '172.16.%', '192.168.%'];

/** 常规页：身份（名称/主机/认证库）、口令与常规属性。 */
export default function GeneralTab({ profile, draft, writable, databases, onIdentityChange, onPasswordChange, onOptionChange }: GeneralTabProps) {
  const { t } = useI18n();
  const kind = profile.kinds.find((item) => item.kind === draft.kind);
  const identity = kind?.identityFields ?? ['name'];
  const identityEditable = writable && (draft.mode === 'create' || kind?.renamable === true);

  return (
    <div className="gn-user-mgmt-tab-body">
      <div className="gn-user-mgmt-form-grid">
        <div className="gn-user-mgmt-field">
          <label className="gn-user-mgmt-field-label" htmlFor="gn-user-mgmt-name">{t('user_management.field.name')}</label>
          <Input
            id="gn-user-mgmt-name"
            value={draft.name}
            disabled={!identityEditable}
            autoComplete="off"
            onChange={(event) => onIdentityChange({ name: event.target.value })}
          />
        </div>
        {identity.includes('host') && (
          <div className="gn-user-mgmt-field">
            <label className="gn-user-mgmt-field-label" htmlFor="gn-user-mgmt-host">{t('user_management.field.host')}</label>
            <AutoComplete
              id="gn-user-mgmt-host"
              value={draft.host}
              disabled={!identityEditable}
              options={HOST_PRESETS.map((value) => ({ value }))}
              onChange={(value) => onIdentityChange({ host: value })}
            />
            <div className="gn-user-mgmt-field-hint">{t('user_management.field.host_hint')}</div>
          </div>
        )}
        {identity.includes('database') && (
          <div className="gn-user-mgmt-field">
            <label className="gn-user-mgmt-field-label" htmlFor="gn-user-mgmt-database">{t('user_management.field.database')}</label>
            {databases.length > 0 ? (
              <Select
                id="gn-user-mgmt-database"
                showSearch
                optionFilterProp="label"
                value={draft.database || undefined}
                disabled={!writable || draft.mode === 'edit'}
                options={(databases.includes(draft.database) || !draft.database ? databases : [draft.database, ...databases]).map((name) => ({ value: name, label: name }))}
                onChange={(value) => onIdentityChange({ database: value ?? '' })}
              />
            ) : (
              <Input
                id="gn-user-mgmt-database"
                value={draft.database}
                disabled={!writable || draft.mode === 'edit'}
                onChange={(event) => onIdentityChange({ database: event.target.value })}
              />
            )}
          </div>
        )}
      </div>
      {kind?.supportsPassword && (
        <PasswordSection profile={profile} draft={draft} writable={writable} onChange={onPasswordChange} />
      )}
      <OptionsForm profile={profile} draft={draft} tab="general" writable={writable} onChange={onOptionChange} />
    </div>
  );
}
