import React from 'react';
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
    <button
      type="button"
      className="gonavi-titlebar-primary-action"
      aria-label={newQueryLabel}
      title={newQueryLabel}
      data-gonavi-new-query-action="true"
      onClick={onNewQuery}
    >
      <ConsoleSqlOutlined />
      {newQueryLabel}
    </button>
    <button
      type="button"
      className="gonavi-titlebar-primary-action"
      aria-label={newConnectionLabel}
      title={newConnectionLabel}
      data-gonavi-create-connection-action="true"
      onClick={onNewConnection}
    >
      <PlusOutlined />
      {newConnectionLabel}
    </button>
  </div>
);

export default TitleBarPrimaryActions;
