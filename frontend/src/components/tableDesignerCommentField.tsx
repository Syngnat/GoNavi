import React from 'react';
import { Input, Tooltip } from 'antd';

import { noAutoCapInputProps } from '../utils/inputAutoCap';

type TableDesignerCommentFieldProps = {
  text?: string;
  readOnly: boolean;
  onChange: (value: string) => void;
};

const focusCommentInput = (event: React.MouseEvent<HTMLDivElement>) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, button')) return;
  const input = event.currentTarget.querySelector('input') as HTMLInputElement | null;
  input?.focus();
};

export const TableDesignerCommentField: React.FC<TableDesignerCommentFieldProps> = ({
  text,
  readOnly,
  onChange,
}) => {
  const value = text || '';
  if (readOnly) {
    return (
      <Tooltip title={value}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      </Tooltip>
    );
  }

  // Always render an Input like name/type. Double-click-to-edit used to wrap a
  // display div in Tooltip; Oracle/Kingbase columns almost always have comments,
  // so the tooltip overlay ate the second click. Empty MySQL comments looked fine.
  return (
    <div
      className="table-designer-cell-field table-designer-comment-field"
      onMouseDown={focusCommentInput}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Input
        {...noAutoCapInputProps}
        title={value}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        variant="borderless"
      />
    </div>
  );
};
