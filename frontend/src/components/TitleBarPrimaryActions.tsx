import React from 'react';
import { Button } from 'antd';
import { ConsoleSqlOutlined, PlusOutlined } from '@ant-design/icons';

interface TitleBarPrimaryActionsProps {
  newQueryLabel: string;
  newConnectionLabel: string;
  onNewQuery: () => void;
  onNewConnection: () => void;
}

const TitleBarPrimaryActions: React.FC<TitleBarPrimaryActionsProps> = ({
  newQueryLabel,
  newConnectionLabel,
  onNewQuery,
  onNewConnection,
}) => (
  <div
    className="gonavi-titlebar-primary-actions"
    data-titlebar-primary-actions="true"
    data-no-titlebar-toggle="true"
    onDoubleClick={(event) => event.stopPropagation()}
  >
    <Button
      size="small"
      type="text"
      className="gonavi-titlebar-primary-action"
      icon={<ConsoleSqlOutlined />}
      aria-label={newQueryLabel}
      title={newQueryLabel}
      data-gonavi-new-query-action="true"
      onClick={onNewQuery}
    >
      {newQueryLabel}
    </Button>
    <Button
      size="small"
      type="text"
      className="gonavi-titlebar-primary-action"
      icon={<PlusOutlined />}
      aria-label={newConnectionLabel}
      title={newConnectionLabel}
      data-gonavi-create-connection-action="true"
      onClick={onNewConnection}
    >
      {newConnectionLabel}
    </Button>
  </div>
);

export default TitleBarPrimaryActions;
