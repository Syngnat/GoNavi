import React from 'react';
import { Input, Tooltip } from 'antd';
import type { InputProps } from 'antd';

import { passThroughHintTooltip } from '../common/tooltipTiming';

interface AICompactValueInputProps extends Omit<InputProps, 'value' | 'onChange'> {
  value?: string;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  compact: (value: string) => string;
  secret?: boolean;
  fullHint?: React.ReactNode;
  visibilityToggle?: boolean | { visible: boolean; onVisibleChange: (visible: boolean) => void };
}

/** Blurred view is compressed; focus shows the real editable value. */
const AICompactValueInput: React.FC<AICompactValueInputProps> = ({
  value, onChange, compact, secret, fullHint, onFocus, onBlur, visibilityToggle, ...rest
}) => {
  const [focused, setFocused] = React.useState(false);
  const raw = String(value ?? '');
  const shown = focused || !raw ? raw : compact(raw);
  const focus = (event: React.FocusEvent<HTMLInputElement>) => { setFocused(true); onFocus?.(event); };
  const blur = (event: React.FocusEvent<HTMLInputElement>) => { setFocused(false); onBlur?.(event); };
  const field = secret
    ? (focused
      ? <Input.Password {...rest} autoFocus value={raw} visibilityToggle={visibilityToggle} onBlur={blur} onChange={onChange} />
      : <Input {...rest} value={shown} onFocus={focus} onChange={(event) => { setFocused(true); onChange?.(event); }} />)
    : <Input {...rest} value={shown} onFocus={focus} onBlur={blur}
        onChange={(event) => { if (!focused) setFocused(true); onChange?.(event); }} />;
  if (!fullHint || focused || !raw || shown === raw) return field;
  return <Tooltip {...passThroughHintTooltip} title={secret ? undefined : fullHint}>{field}</Tooltip>;
};

export default AICompactValueInput;
