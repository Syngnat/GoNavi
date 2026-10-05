import React from 'react';

// P2 性能优化：提取内联 style 对象为模块级常量，避免每次 render 创建新对象
export const CELL_ELLIPSIS_STYLE: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, width: '100%' };
export const VIRTUAL_CELL_TEXT_STYLE: React.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    width: '100%',
};
export const READONLY_CELL_WRAP_STYLE: React.CSSProperties = { minHeight: 20, display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 };
export const INLINE_EDIT_FORM_ITEM_STYLE: React.CSSProperties = { margin: 0, width: '100%', minWidth: 0 };
export const VIRTUAL_EDITING_CELL_STYLE: React.CSSProperties = {
    margin: 0,
    padding: 0,
    display: 'flex',
    flex: '1 1 auto',
    alignItems: 'center',
    width: '100%',
    minWidth: 0,
    minHeight: 'calc(28px * var(--gn-ui-scale, 1))',
    height: 'calc(28px * var(--gn-ui-scale, 1))',
    overflow: 'visible',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
};
