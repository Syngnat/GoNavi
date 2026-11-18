import React from 'react';
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

  return (
    <div className="gn-object-info-ddl">
      <div className="gn-object-info-ddl-title">{title}</div>
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
