import React from 'react';
import { Spin } from 'antd';
import type { TabData } from '../../types';
import { useSettingsCenterWorkbenchRenderer } from './SettingsCenterWorkbenchBridge';

interface SettingsCenterWorkbenchProps {
  tab: TabData;
  isActive?: boolean;
}

const SettingsCenterWorkbench: React.FC<SettingsCenterWorkbenchProps> = ({
  tab: _tab,
  isActive: _isActive = true,
}) => {
  const renderer = useSettingsCenterWorkbenchRenderer();
  const content = renderer ? renderer() : null;

  return (
    <div
      className="gonavi-settings-center-workbench-host"
      style={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      data-gonavi-settings-center-workbench="true"
    >
      {content ?? (
        <div
          aria-busy="true"
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            minHeight: 0,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Spin size="small" />
        </div>
      )}
    </div>
  );
};

export default SettingsCenterWorkbench;
