import { Input, InputNumber, Select, Switch, Tag, Tooltip } from 'antd';
import { useI18n } from '../../../i18n/provider';
import { userManagementChoiceLabel, userManagementOptionLabel } from '../userManagementFieldLabels';
import { GnInfoIcon } from '../userManagementIcons';
import DateTimeField from './DateTimeField';
import type { UMOptionDescriptor } from '../userManagementTypes';

interface OptionFieldProps {
  descriptor: UMOptionDescriptor;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

const splitList = (value: string): string[] => value.split('\n').map((item) => item.trim()).filter(Boolean);

/** 按后端描述符通用渲染一个属性字段；前端不感知具体数据源方言。 */
export default function OptionField({ descriptor, value, disabled, onChange }: OptionFieldProps) {
  const { t } = useI18n();
  const label = userManagementOptionLabel(descriptor.id, t);
  const choiceOptions = descriptor.choices.map((choice) => ({
    value: choice.value,
    disabled: choice.disabled,
    label: (
      <span className="gn-user-mgmt-choice">
        {userManagementChoiceLabel(descriptor.id, choice.value, t) || choice.label || choice.value}
        {choice.deprecated && <Tag color="orange" className="gn-user-mgmt-choice-tag">{t('user_management.option.deprecated')}</Tag>}
      </span>
    ),
  }));
  const selectedChoice = descriptor.choices.find((choice) => choice.value === value);
  const hint = selectedChoice?.hint || descriptor.hint;

  const control = (() => {
    switch (descriptor.type) {
      case 'bool':
        return <Switch checked={value === 'true'} disabled={disabled} onChange={(checked) => onChange(String(checked))} aria-label={label} />;
      case 'int':
        return (
          <InputNumber
            value={value === '' ? null : Number(value)}
            min={descriptor.min}
            max={descriptor.max || undefined}
            precision={0}
            disabled={disabled}
            placeholder={t('user_management.option.default_placeholder')}
            onChange={(next) => onChange(next === null || next === undefined ? '' : String(next))}
            aria-label={label}
            className="gn-user-mgmt-number"
          />
        );
      case 'enum':
        return <Select value={value || undefined} options={choiceOptions} disabled={disabled} allowClear={!descriptor.required} onChange={(next) => onChange(next ?? '')} aria-label={label} />;
      case 'multi':
      case 'list':
        return (
          <Select
            mode={descriptor.type === 'multi' && descriptor.choices.length > 0 ? 'multiple' : 'tags'}
            value={splitList(value)}
            options={choiceOptions}
            disabled={disabled}
            tokenSeparators={descriptor.type === 'list' ? [' ', '\n'] : undefined}
            onChange={(next: string[]) => onChange(next.join('\n'))}
            aria-label={label}
          />
        );
      case 'text':
        return <Input.TextArea value={value} disabled={disabled} autoSize={{ minRows: 2, maxRows: 8 }} onChange={(event) => onChange(event.target.value)} aria-label={label} />;
      case 'datetime':
        return <DateTimeField value={value} disabled={disabled} label={label} onChange={onChange} />;
      default:
        return <Input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-label={label} />;
    }
  })();

  return (
    <div className={`gn-user-mgmt-field gn-user-mgmt-field-${descriptor.type}`} data-option-id={descriptor.id}>
      <label className="gn-user-mgmt-field-label">
        {label}
        {hint && (
          <Tooltip title={hint}>
            <GnInfoIcon className="gn-user-mgmt-field-hint-icon" />
          </Tooltip>
        )}
      </label>
      <div className="gn-user-mgmt-field-control">{control}</div>
      {hint && descriptor.type !== 'bool' && <div className="gn-user-mgmt-field-hint">{hint}</div>}
    </div>
  );
}
