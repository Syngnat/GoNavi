import { Alert } from 'antd';
import { useI18n } from '../../../i18n/provider';
import type { PrincipalDraft } from '../userManagementDraft';
import type { UMServerProfile } from '../userManagementTypes';
import OptionsForm from './OptionsForm';

interface RedisAclRulesTabProps {
  profile: UMServerProfile;
  draft: PrincipalDraft;
  writable: boolean;
  onOptionChange: (id: string, value: string) => void;
}

/**
 * Redis ACL 规则页：键模式、频道模式、命令/分类规则与 7.0 selectors。
 * 字段由后端按版本下发（6.2 前无频道、7.0 前无 selectors），这里通用渲染。
 */
export default function RedisAclRulesTab({ profile, draft, writable, onOptionChange }: RedisAclRulesTabProps) {
  const { t } = useI18n();
  return (
    <div className="gn-user-mgmt-tab-body">
      <Alert type="info" showIcon message={t('user_management.redis.rules_hint')} />
      <OptionsForm profile={profile} draft={draft} tab="redis-rules" writable={writable} onChange={onOptionChange} />
    </div>
  );
}
