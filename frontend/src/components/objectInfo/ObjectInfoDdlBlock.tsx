import React from 'react';
import { message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus';
import vs from 'react-syntax-highlighter/dist/esm/styles/prism/vs';

import { t } from '../../i18n';
import { useStore } from '../../store';

SyntaxHighlighter.registerLanguage('sql', sql);

type ObjectInfoDdlBlockProps = {
  ddl: string;
  database: boolean;
};

export const ObjectInfoDdlBlock: React.FC<ObjectInfoDdlBlockProps> = ({ ddl, database }) => {
  const darkMode = useStore(state => state.theme === 'dark');
  const databaseTitleKey = 'object_info.section.database_ddl';
  const translatedDatabaseTitle = t(databaseTitleKey);
  const title = database
    ? (translatedDatabaseTitle === databaseTitleKey
        ? t('object_info.section.ddl')
        : translatedDatabaseTitle)
    : t('object_info.section.ddl');
  const copyLabel = t('object_info.action.copy');

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(ddl);
      message.success(t('object_info.message.copied'));
    } catch (error) {
      message.error(t('object_info.message.copy_failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  return (
    <div className="gn-object-info-ddl">
      <div className="gn-object-info-ddl-title">
        <span className="gn-object-info-ddl-title-text">{title}</span>
        <button
          type="button"
          className="gn-object-info-ddl-copy"
          onClick={() => void handleCopy()}
          aria-label={copyLabel}
          title={copyLabel}
        >
          <CopyOutlined />
          <span>{copyLabel}</span>
        </button>
      </div>
      <div
        className="gn-object-info-ddl-body"
        role="region"
        aria-label={title}
        tabIndex={0}
        data-object-info-ddl={database ? 'database' : 'table'}
      >
        <SyntaxHighlighter
          language="sql"
          style={(darkMode ? vscDarkPlus : vs) as Record<string, React.CSSProperties>}
          PreTag="pre"
          showLineNumbers
          customStyle={{
            margin: 0,
            padding: 0,
            background: 'transparent',
            overflow: 'visible',
            fontFamily: 'var(--gn-font-mono, monospace)',
            fontSize: 'var(--gn-font-size-xs, 11px)',
            lineHeight: 1.65,
          }}
          codeTagProps={{
            style: {
              fontFamily: 'inherit',
              fontSize: 'inherit',
            },
          }}
          lineNumberStyle={{
            minWidth: '2.4em',
            paddingRight: '0.9em',
            opacity: 0.55,
          }}
        >
          {ddl}
        </SyntaxHighlighter>
      </div>
    </div>
  );
};
