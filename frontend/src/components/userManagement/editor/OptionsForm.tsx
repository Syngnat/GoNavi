import type { PrincipalDraft } from '../userManagementDraft';
import type { UMOptionDescriptor, UMServerProfile } from '../userManagementTypes';
import OptionField from './OptionField';

interface OptionsFormProps {
  profile: UMServerProfile;
  draft: PrincipalDraft;
  tab: string;
  writable: boolean;
  onChange: (id: string, value: string) => void;
  exclude?: string[];
}

export const optionsForTab = (profile: UMServerProfile, draft: PrincipalDraft, tab: string, exclude: string[] = []): UMOptionDescriptor[] => (
  profile.options.filter((option) => option.tab === tab
    && !exclude.includes(option.id)
    && (option.kinds.length === 0 || option.kinds.includes(draft.kind)))
);

/**
 * 渲染某个编辑页下适用于当前主体种类的全部属性字段。
 * 开关类字段单独成组放在最后：字段下方的说明文字会把同一行撑高，混排时开关会与输入框错位。
 */
export default function OptionsForm({ profile, draft, tab, writable, onChange, exclude }: OptionsFormProps) {
  const options = optionsForTab(profile, draft, tab, exclude);
  if (options.length === 0) return null;
  const renderGroup = (group: UMOptionDescriptor[], className: string) => (group.length === 0 ? null : (
    <div className={className}>
      {group.map((descriptor) => (
        <OptionField
          key={descriptor.id}
          descriptor={descriptor}
          value={draft.options[descriptor.id] ?? ''}
          disabled={!writable || descriptor.readOnly === true || (descriptor.createOnly === true && draft.mode === 'edit')}
          onChange={(value) => onChange(descriptor.id, value)}
        />
      ))}
    </div>
  ));
  return (
    <>
      {renderGroup(options.filter((option) => option.type !== 'bool'), 'gn-user-mgmt-form-grid')}
      {renderGroup(options.filter((option) => option.type === 'bool'), 'gn-user-mgmt-form-grid is-toggles')}
    </>
  );
}
