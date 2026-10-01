export interface PillOption<T extends string> {
  value: T;
  label: string;
}

interface SettingsPillsProps<T extends string> {
  ariaLabel: string;
  /** 每个按钮上写入 option.value 的 data 属性名，供测试与样式定位；可省略。 */
  dataAttribute?: string;
  options: PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** 与「新版左侧搜索模式」一致的分段按钮。 */
export default function SettingsPills<T extends string>({
  ariaLabel,
  dataAttribute,
  options,
  value,
  onChange,
}: SettingsPillsProps<T>) {
  return (
    <div className="gonavi-settings-pills" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`gonavi-settings-pill${active ? ' is-active' : ''}`}
            aria-pressed={active}
            {...(dataAttribute ? { [dataAttribute]: option.value } : {})}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
