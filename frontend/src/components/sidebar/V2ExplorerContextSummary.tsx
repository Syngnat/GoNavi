import React from 'react';
import { Tooltip } from 'antd';

export type V2ExplorerContext = {
  active: boolean;
  connectionName: string;
  databaseName: string;
  objectName: string;
  tooltip: string;
};

export const V2ExplorerContextSummary: React.FC<{ context: V2ExplorerContext }> = ({ context }) => (
  <Tooltip
    title={(
      <div
        className="gn-v2-explorer-context-tooltip"
        data-sidebar-active-context-tooltip="true"
      >
        <strong
          className="gn-v2-explorer-context-tooltip-line is-connection"
          data-sidebar-active-context-tooltip-field="connection"
        >
          {context.connectionName}
        </strong>
        <span
          className="gn-v2-explorer-context-tooltip-line is-database"
          data-sidebar-active-context-tooltip-field="database"
        >
          {context.databaseName}
        </span>
        <span
          className="gn-v2-explorer-context-tooltip-line is-object"
          data-sidebar-active-context-tooltip-field="object"
        >
          {context.objectName}
        </span>
      </div>
    )}
    placement="bottomLeft"
    mouseEnterDelay={0.35}
    rootClassName="gn-v2-explorer-context-tooltip-popup"
  >
    <div
      className="gn-v2-explorer-context"
      data-sidebar-active-context-summary="true"
      data-sidebar-active-context={context.active ? 'true' : 'false'}
      data-sidebar-active-context-depth={context.objectName ? 'object' : context.databaseName ? 'database' : 'connection'}
      aria-label={context.tooltip}
    >
      <span className="gn-v2-explorer-context-copy">
        <strong
          className="gn-v2-explorer-context-line is-connection"
          data-sidebar-active-context-field="connection"
        >
          {context.connectionName}
        </strong>
        <span
          className="gn-v2-explorer-context-line is-database"
          data-sidebar-active-context-field="database"
        >
          {context.databaseName}
        </span>
        <span
          className="gn-v2-explorer-context-line is-object"
          data-sidebar-active-context-field="object"
        >
          {context.objectName}
        </span>
      </span>
    </div>
  </Tooltip>
);
