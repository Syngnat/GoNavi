import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

import { noAutoCapInputProps } from '../../utils/inputAutoCap';

export const TABLE_OVERVIEW_SEARCH_DEBOUNCE_MS = 120;

type TableOverviewSearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  iconColor: string;
};

export const TableOverviewSearchInput: React.FC<TableOverviewSearchInputProps> = ({
  value,
  onChange,
  placeholder,
  ariaLabel,
  iconColor,
}) => {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const committedRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const commit = useCallback((next: string) => {
    clearTimer();
    committedRef.current = next;
    onChange(next);
  }, [clearTimer, onChange]);

  useEffect(() => {
    if (value === committedRef.current) return;
    clearTimer();
    committedRef.current = value;
    draftRef.current = value;
    setDraft(value);
  }, [clearTimer, value]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const handleChange = (next: string) => {
    draftRef.current = next;
    setDraft(next);
    clearTimer();
    if (!next) {
      commit('');
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (next !== committedRef.current) commit(next);
    }, TABLE_OVERVIEW_SEARCH_DEBOUNCE_MS);
  };

  return (
    <Input
      {...noAutoCapInputProps}
      placeholder={placeholder}
      aria-label={ariaLabel}
      prefix={<SearchOutlined style={{ color: iconColor }} />}
      value={draft}
      onChange={(event) => handleChange(event.target.value)}
      onPressEnter={() => {
        if (draftRef.current !== committedRef.current) commit(draftRef.current);
      }}
      allowClear
      style={{ width: 240 }}
      size="small"
    />
  );
};
