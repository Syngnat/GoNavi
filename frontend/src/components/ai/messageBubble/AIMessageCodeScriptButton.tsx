import React from 'react';
import { Tooltip } from 'antd';
import { CodeOutlined } from '@ant-design/icons';
import { t as catalogTranslate } from '../../../i18n/catalog';
import { useOptionalI18n } from '../../../i18n/provider';
import { SCRIPT_WORKBENCH_OPEN_EVENT } from '../../../utils/scriptWorkbenchTab';

const useCodeCopy = () => {
  const i18n = useOptionalI18n();
  return (key: string) => (
    i18n?.t(key) ?? catalogTranslate('en-US', key)
  );
};

export const AIMessageCodeScriptButton: React.FC<{
  codeText: string;
  connectionId?: string;
  dbName?: string;
}> = ({ codeText, connectionId, dbName }) => {
  const copy = useCodeCopy();
  const openInWorkbench = () => {
    window.dispatchEvent(new CustomEvent(SCRIPT_WORKBENCH_OPEN_EVENT, {
      detail: {
        source: codeText,
        connectionId,
        dbName,
        displayName: copy('ai_chat.message.code.script_name'),
      },
    }));
  };

  return (
    <Tooltip title={copy('ai_chat.message.code.open_script_tooltip')}>
      <button
        type="button"
        className="ai-code-run-btn ai-code-script-btn"
        onClick={openInWorkbench}
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 4px',
          border: 0,
          color: '#1677ff',
          background: 'transparent',
          opacity: 0.7,
          fontSize: 'inherit',
        }}
      >
        <CodeOutlined aria-hidden="true" />
        <span>{copy('ai_chat.message.code.open_script_workbench')}</span>
      </button>
    </Tooltip>
  );
};
