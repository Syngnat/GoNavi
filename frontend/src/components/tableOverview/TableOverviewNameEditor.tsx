import React from 'react';
import { Input } from 'antd';

import { noAutoCapInputProps } from '../../utils/inputAutoCap';

export interface TableOverviewNameEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 失焦 / 回车提交（改名真正落库）。 */
  onCommit: () => void;
  /** Esc 放弃本次编辑。 */
  onCancel: () => void;
  /** 供「点编辑器以外的地方」判定用。 */
  editorRef?: React.MutableRefObject<HTMLSpanElement | null>;
  ariaLabel?: string;
}

// 表概览里表名的就地编辑框：卡片 / 列表 / 紧凑表三种视图共用。
// 编辑期间吞掉行上的点击，避免又被选中手势当成一次单击。
export const TableOverviewNameEditor: React.FC<TableOverviewNameEditorProps> = ({
  value, onChange, onCommit, onCancel, editorRef, ariaLabel,
}) => (
  <span
    ref={editorRef}
    className="gn-table-overview-name-editor"
    data-table-overview-name-editor="true"
    onClick={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
  >
    <Input
      {...noAutoCapInputProps}
      size="small"
      autoFocus
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      onPressEnter={() => onCommit()}
      onBlur={() => onCommit()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
      style={{ width: '100%' }}
    />
  </span>
);

export default TableOverviewNameEditor;
