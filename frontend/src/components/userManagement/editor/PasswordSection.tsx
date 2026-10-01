import { Button, Checkbox, Input, Tooltip } from 'antd';
import { useI18n } from '../../../i18n/provider';
import { GnBoltIcon } from '../../icons/gnIcons';
import { checkPasswordPolicy, estimatePasswordStrength, generatePassword } from '../passwordGenerator';
import type { PasswordDraft, PrincipalDraft } from '../userManagementDraft';
import { GnEyeIcon, GnEyeOffIcon } from '../userManagementIcons';
import type { UMServerProfile } from '../userManagementTypes';

interface PasswordSectionProps {
  profile: UMServerProfile;
  draft: PrincipalDraft;
  writable: boolean;
  onChange: (patch: Partial<PasswordDraft>) => void;
}

const STRENGTH_STEPS = [1, 2, 3, 4];
const passwordIcon = (visible: boolean) => (visible ? <GnEyeIcon /> : <GnEyeOffIcon />);

/** 口令编辑：生成、强度、服务端策略预检、当前口令与双口令选项。 */
export default function PasswordSection({ profile, draft, writable, onChange }: PasswordSectionProps) {
  const { t } = useI18n();
  const password = draft.password;
  const editing = draft.mode === 'create' || password.set;
  const failures = password.value ? checkPasswordPolicy(password.value, draft.name, profile.passwordPolicy) : [];
  const mismatch = password.confirm !== '' && password.confirm !== password.value;
  const strength = estimatePasswordStrength(password.value);
  const needsCurrent = profile.features.requireCurrent || profile.features.replacePassword;

  const fill = () => {
    const generated = generatePassword(profile.passwordPolicy);
    onChange({ set: true, value: generated, confirm: generated });
  };

  return (
    <div className="gn-user-mgmt-password" role="group" aria-label={t('user_management.password.title')}>
      {draft.mode === 'edit' && (
        <Checkbox
          checked={password.set}
          disabled={!writable}
          onChange={(event) => onChange({ set: event.target.checked, value: '', confirm: '', current: '' })}
        >
          {t('user_management.password.change')}
        </Checkbox>
      )}
      {editing && (
        <div className="gn-user-mgmt-form-grid">
          <div className="gn-user-mgmt-field">
            <label className="gn-user-mgmt-field-label" htmlFor="gn-user-mgmt-password">{t('user_management.password.new')}</label>
            <div className="gn-user-mgmt-password-row">
              <Input.Password
                id="gn-user-mgmt-password"
                autoComplete="new-password"
                value={password.value}
                disabled={!writable}
                iconRender={passwordIcon}
                onChange={(event) => onChange({ set: true, value: event.target.value })}
              />
              <Tooltip title={t('user_management.password.generate')}>
                <Button icon={<GnBoltIcon />} disabled={!writable} onClick={fill} aria-label={t('user_management.password.generate')} />
              </Tooltip>
            </div>
            <div className={`gn-user-mgmt-strength level-${strength}`} aria-hidden="true">
              {STRENGTH_STEPS.map((step) => <span key={step} className={step <= strength ? 'is-on' : ''} />)}
            </div>
          </div>
          <div className="gn-user-mgmt-field">
            <label className="gn-user-mgmt-field-label" htmlFor="gn-user-mgmt-password-confirm">{t('user_management.password.confirm')}</label>
            <Input.Password
              id="gn-user-mgmt-password-confirm"
              autoComplete="new-password"
              value={password.confirm}
              status={mismatch ? 'error' : undefined}
              disabled={!writable}
              iconRender={passwordIcon}
              onChange={(event) => onChange({ confirm: event.target.value })}
            />
            {mismatch && <div className="gn-user-mgmt-field-error">{t('user_management.password.mismatch')}</div>}
          </div>
          {draft.mode === 'edit' && needsCurrent && (
            <div className="gn-user-mgmt-field">
              <label className="gn-user-mgmt-field-label" htmlFor="gn-user-mgmt-password-current">{t('user_management.password.current')}</label>
              <Input.Password
                id="gn-user-mgmt-password-current"
                autoComplete="current-password"
                value={password.current}
                disabled={!writable}
                iconRender={passwordIcon}
                placeholder={t('user_management.password.current_placeholder')}
                onChange={(event) => onChange({ current: event.target.value })}
              />
            </div>
          )}
          {draft.mode === 'edit' && profile.features.dualPassword && (
            <Checkbox checked={password.retainCurrent} disabled={!writable} onChange={(event) => onChange({ retainCurrent: event.target.checked })}>
              {t('user_management.password.retain_current')}
            </Checkbox>
          )}
        </div>
      )}
      {editing && failures.length > 0 && (
        <ul className="gn-user-mgmt-policy-list">
          {failures.map((rule) => <li key={rule}>{t('user_management.password.policy_hint', { rule: policyRuleText(rule, profile, t) })}</li>)}
        </ul>
      )}
    </div>
  );
}

const policyRuleText = (rule: string, profile: UMServerProfile, t: (key: string, params?: Record<string, string | number>) => string): string => {
  const policy = profile.passwordPolicy;
  switch (rule) {
    case 'min_length': return t('user_management.backend.error.password_policy.min_length', { value: policy.minLength });
    case 'max_length': return t('user_management.backend.error.password_policy.max_length', { value: policy.maxLength });
    case 'upper': return t('user_management.backend.error.password_policy.upper');
    case 'lower': return t('user_management.backend.error.password_policy.lower');
    case 'digit': return t('user_management.backend.error.password_policy.digit');
    case 'special': return t('user_management.backend.error.password_policy.special');
    case 'categories': return t('user_management.backend.error.password_policy.categories', { value: policy.minCategories });
    case 'username': return t('user_management.backend.error.password_policy.username');
    default: return rule;
  }
};

/** 口令草稿是否可提交：新建必须填写；修改时两次一致。 */
export const isPasswordDraftValid = (draft: PrincipalDraft, requiresPassword: boolean): boolean => {
  const password = draft.password;
  if (draft.mode === 'create' && requiresPassword && !password.value) return false;
  if (!password.set) return true;
  return password.value !== '' && password.value === password.confirm;
};
