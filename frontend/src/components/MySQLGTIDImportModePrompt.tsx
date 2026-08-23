import React from 'react';
import { Radio, Typography } from 'antd';

import { t as defaultTranslate } from '../i18n';
import Modal from './common/ResizableDraggableModal';

const { Paragraph, Text } = Typography;

export type MySQLGTIDImportMode = 'reject' | 'skip' | 'reset';

type MySQLGTIDConflictResolution = Exclude<MySQLGTIDImportMode, 'reject'>;

export const requestMySQLGTIDImportMode = (
  translate: typeof defaultTranslate,
): Promise<MySQLGTIDConflictResolution | null> => new Promise((resolve) => {
  let selectedMode: MySQLGTIDConflictResolution = 'skip';
  let settled = false;
  const settle = (value: MySQLGTIDConflictResolution | null) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };

  Modal.confirm({
    title: translate('data_import.workbench.gtid.title'),
    width: 560,
    content: (
      <div style={{ display: 'grid', gap: 14 }}>
        <Paragraph style={{ margin: 0 }}>
          {translate('data_import.workbench.gtid.description')}
        </Paragraph>
        <Radio.Group
          data-mysql-gtid-mode-selector="true"
          defaultValue="skip"
          onChange={(event) => {
            selectedMode = event.target.value === 'reset' ? 'reset' : 'skip';
          }}
          style={{ display: 'grid', gap: 12 }}
        >
          <div>
            <Radio value="skip">
              <Text strong>{translate('data_import.workbench.gtid.option.skip')}</Text>
            </Radio>
            <Text type="secondary" style={{ display: 'block', margin: '4px 0 0 24px' }}>
              {translate('data_import.workbench.gtid.option.skip_description')}
            </Text>
          </div>
          <div>
            <Radio value="reset">
              <Text strong>{translate('data_import.workbench.gtid.option.reset')}</Text>
            </Radio>
            <Text type="danger" style={{ display: 'block', margin: '4px 0 0 24px' }}>
              {translate('data_import.workbench.gtid.option.reset_description')}
            </Text>
          </div>
        </Radio.Group>
      </div>
    ),
    okText: translate('data_import.workbench.gtid.action.continue'),
    cancelText: translate('common.cancel'),
    onOk: () => settle(selectedMode),
    onCancel: () => settle(null),
  });
});
