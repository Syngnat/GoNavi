import { DatePicker, Input } from 'antd';
import dayjs from 'dayjs';

interface DateTimeFieldProps {
  value: string;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
}

const DATE_TIME_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/**
 * 日期时间字段：日期时间选择器，仍保持 `YYYY-MM-DD HH:mm:ss` 文本值。
 * 服务端返回的值若不是可解析的日期（如 infinity、带时区后缀），退回文本框原样展示，清空后即可改用选择器。
 */
export default function DateTimeField({ value, disabled, label, onChange }: DateTimeFieldProps) {
  const parsed = value ? dayjs(value) : null;
  if (value && !parsed?.isValid()) {
    return <Input allowClear value={value} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.value)} />;
  }
  return (
    <DatePicker
      showTime
      allowClear
      className="gn-user-mgmt-number"
      format={DATE_TIME_FORMAT}
      value={parsed}
      disabled={disabled}
      placeholder={DATE_TIME_FORMAT}
      aria-label={label}
      onChange={(next) => onChange(next ? next.format(DATE_TIME_FORMAT) : '')}
    />
  );
}
