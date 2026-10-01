import React from 'react';
import { Button, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { CheckOutlined, DownOutlined } from '@ant-design/icons';

import type { AIApprovalScope } from './aiAutoApproval';

interface AIApprovalSplitButtonProps {
  loading: boolean;
  disabled: boolean;
  labels: {
    approve: string;
    once: string;
    session: string;
    global: string;
    more: string;
  };
  onApprove: (scope: AIApprovalScope) => void;
}

/**
 * "Approve" with a drop-down for how long the decision holds. The main button
 * keeps the old one-shot behaviour; the menu adds "always in this session" and
 * "always, everywhere".
 */
const AIApprovalSplitButton: React.FC<AIApprovalSplitButtonProps> = ({ loading, disabled, labels, onApprove }) => {
  const items: MenuProps['items'] = [
    { key: 'once', label: labels.once },
    { key: 'session', label: labels.session },
    { key: 'global', label: labels.global, danger: true },
  ];

  return (
    <span className="ai-approve-split">
      <Button
        size="small"
        type="primary"
        className="ai-approve-btn ai-approve-main"
        icon={<CheckOutlined />}
        loading={loading}
        disabled={disabled}
        onClick={() => onApprove('once')}
      >
        {labels.approve}
      </Button>
      <Dropdown
        trigger={['click']}
        placement="topRight"
        disabled={disabled || loading}
        menu={{ items, onClick: ({ key }) => onApprove(key as AIApprovalScope) }}
      >
        <Button
          size="small"
          type="primary"
          className="ai-approve-btn ai-approve-more"
          aria-label={labels.more}
          icon={<DownOutlined />}
          disabled={disabled || loading}
        />
      </Dropdown>
    </span>
  );
};

export default AIApprovalSplitButton;
