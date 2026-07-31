import React, { useState } from 'react';
import { Tooltip, message } from 'antd';
import { CheckOutlined, CopyOutlined, PlayCircleOutlined } from '@ant-design/icons';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus';
import vs from 'react-syntax-highlighter/dist/esm/styles/prism/vs';

import { t as catalogTranslate } from '../../../i18n/catalog';
import type { I18nParams } from '../../../i18n/types';
import { useOptionalI18n } from '../../../i18n/provider';
import Modal from '../../common/ResizableDraggableModal';
import type { OverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { buildAIReadonlyPreviewSQL } from '../../../utils/aiSqlLimit';

[
  bash,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  php,
  python,
  ruby,
  rust,
  sql,
  toml,
  tsx,
  typescript,
  yaml,
].forEach((language) => SyntaxHighlighter.registerLanguage('', language));

interface AIMessageCodeBlockProps {
  className?: string;
  inline?: boolean;
  children?: React.ReactNode;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  activeConnectionConfig?: any;
  activeConnectionId?: string;
  activeDbName?: string;
}

interface HighlightedCodeBlockProps {
  language: string;
  codeText: string;
  displayText: string;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  activeConnectionConfig?: any;
  activeConnectionId?: string;
  activeDbName?: string;
}

const useMessageCopy = () => {
  const i18n = useOptionalI18n();
  return (key: string, params?: I18nParams) => (
    i18n?.t ?? ((catalogKey, catalogParams) => catalogTranslate('en-US', catalogKey, catalogParams))
  )(key, params);
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const MermaidRenderer: React.FC<{ chart: string; darkMode: boolean }> = ({ chart, darkMode }) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const copy = useMessageCopy();

  React.useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        if (cancelled || !containerRef.current) {
          return;
        }

        mermaid.initialize({ startOnLoad: false, theme: darkMode ? 'dark' : 'default' });
        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const result: any = await mermaid.render(id, chart);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = result.svg || result;
        }
      } catch (error: any) {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = `<div style="color:#ef4444; padding:12px; background:rgba(239,68,68,0.1); border-radius:6px; font-size:12px">${escapeHtml(copy('ai_chat.message.mermaid.render_failed', { detail: error?.message || '' }))}</div>`;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, copy, darkMode]);

  return <div ref={containerRef} className="ai-mermaid-container" style={{ margin: '16px 0', display: 'flex', justifyContent: 'flex-start', overflowX: 'auto' }} />;
};

const CodeCopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = useMessageCopy();

  return (
    <span
      className="ai-code-copy-btn"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      style={{
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        opacity: copied ? 1 : 0.6,
        transition: 'opacity 0.2s',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(event) => { event.currentTarget.style.opacity = copied ? '1' : '0.6'; }}
    >
      {copied ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
      <span style={{ marginLeft: 4 }}>{copied ? copy('ai_chat.message.code.copied') : copy('ai_chat.message.code.copy')}</span>
    </span>
  );
};

const CodeRunButton: React.FC<{ text: string; connectionId?: string; dbName?: string }> = ({ text, connectionId, dbName }) => {
  const copy = useMessageCopy();
  const contextMatch = text.match(/^--\s*@context\s+connectionId=(\S+)\s+dbName=(\S+)/m);
  const resolvedConnId = contextMatch?.[1] || connectionId;
  const resolvedDbName = contextMatch?.[2] || dbName;
  const cleanSql = text.replace(/^--\s*@context\s+.*\n?/gm, '').trim();
  const sqlDetail = (runImmediately: boolean) => ({
    sql: cleanSql,
    runImmediately,
    connectionId: resolvedConnId,
    dbName: resolvedDbName,
  });

  const handleExecute = async () => {
    try {
      const Service = (window as any).go?.aiservice?.Service;
      if (Service?.AICheckSQL) {
        const result = await Service.AICheckSQL(text);
        if (!result.allowed) {
          message.error(copy('ai_chat.message.security.blocked', { operationType: result.operationType }));
          return;
        }
        if (result.requiresConfirm) {
          Modal.confirm({
            title: copy('ai_chat.message.security.confirm_title'),
            content: result.warningMessage || copy('ai_chat.message.security.default_warning', { operationType: result.operationType }),
            okText: copy('ai_chat.message.security.confirm_execute'),
            cancelText: copy('common.cancel'),
            okButtonProps: { danger: true },
            onOk: () => {
              window.dispatchEvent(new CustomEvent('gonavi:insert-sql', { detail: sqlDetail(true) }));
            },
          });
          return;
        }
      }
      window.dispatchEvent(new CustomEvent('gonavi:insert-sql', { detail: sqlDetail(true) }));
    } catch {
      window.dispatchEvent(new CustomEvent('gonavi:insert-sql', { detail: sqlDetail(true) }));
    }
  };

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Tooltip title={copy('ai_chat.message.code.insert_tooltip')}>
        <span
          className="ai-code-run-btn"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('gonavi:insert-sql', { detail: sqlDetail(false) }));
          }}
          style={{
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            opacity: 0.6,
            transition: 'opacity 0.2s',
            padding: '0 4px',
            color: '#10b981',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(event) => { event.currentTarget.style.opacity = '0.6'; }}
        >
          <PlayCircleOutlined />
          <span style={{ marginLeft: 4 }}>{copy('ai_chat.message.code.insert')}</span>
        </span>
      </Tooltip>
      <Tooltip title={copy('ai_chat.message.code.execute_tooltip')}>
        <span
          className="ai-code-run-btn"
          onClick={handleExecute}
          style={{
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            opacity: 0.6,
            transition: 'opacity 0.2s',
            padding: '0 4px',
            color: '#1677ff',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(event) => { event.currentTarget.style.opacity = '0.6'; }}
        >
          <PlayCircleOutlined />
          <span style={{ marginLeft: 4 }}>{copy('ai_chat.message.code.execute')}</span>
        </span>
      </Tooltip>
    </div>
  );
};

const HighlightedCodeBlock: React.FC<HighlightedCodeBlockProps> = ({
  language,
  codeText,
  displayText,
  darkMode,
  overlayTheme,
  activeConnectionConfig,
  activeConnectionId,
  activeDbName,
}) => {
  const copy = useMessageCopy();
  const [expanded, setExpanded] = useState(false);
  const [previewData, setPreviewData] = useState<any[] | null>(null);
  const [previewCols, setPreviewCols] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const isLongCode = displayText.split('\n').length > 15;
  const isSql = language === 'sql';
  const isSelectQuery = isSql && /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(displayText.trim());

  const handleInlineExecute = async () => {
    if (!activeConnectionConfig || previewLoading) {
      return;
    }
    setPreviewLoading(true);
    setPreviewError('');
    setPreviewData(null);
    try {
      const { DBQueryAI } = await import('../../../../wailsjs/go/app/App');
      const previewSql = buildAIReadonlyPreviewSQL(
        activeConnectionConfig?.type || '',
        displayText,
        50,
        activeConnectionConfig?.driver || '',
        { oceanBaseProtocol: activeConnectionConfig?.oceanBaseProtocol },
      );
      const response = await DBQueryAI(activeConnectionConfig, activeDbName || '', previewSql);
      if (response.success && Array.isArray(response.data)) {
        const rows = response.data as any[];
        setPreviewCols(rows.length > 0 ? Object.keys(rows[0]) : []);
        setPreviewData(rows.slice(0, 20));
        setPreviewExpanded(true);
      } else {
        setPreviewError(response.message || copy('ai_chat.message.code.query_no_result'));
      }
    } catch (error: any) {
      setPreviewError(error?.message || copy('ai_chat.message.code.execute_failed'));
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="ai-code-block-container" style={{ margin: '12px 0', border: overlayTheme.sectionBorder, borderRadius: 6, overflow: 'hidden' }}>
      <div
        className="ai-code-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 12px',
          background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          fontSize: 12,
          color: overlayTheme.mutedText,
        }}
      >
        <span style={{ fontFamily: 'var(--gn-font-mono)' }}>{language}</span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {isSql && <CodeRunButton text={codeText} connectionId={activeConnectionId} dbName={activeDbName} />}
          {isSelectQuery && activeConnectionConfig && (
            <Tooltip title={copy('ai_chat.message.code.preview_tooltip')}>
              <span
                onClick={handleInlineExecute}
                style={{
                  cursor: previewLoading ? 'wait' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  opacity: previewLoading ? 1 : 0.6,
                  transition: 'opacity 0.2s',
                  padding: '0 4px',
                  color: '#faad14',
                }}
                onMouseEnter={(event) => {
                  if (!previewLoading) {
                    event.currentTarget.style.opacity = '1';
                  }
                }}
                onMouseLeave={(event) => {
                  if (!previewLoading) {
                    event.currentTarget.style.opacity = '0.6';
                  }
                }}
              >
                {previewLoading ? '⏳' : '👁'}
                <span style={{ marginLeft: 4 }}>{previewLoading ? copy('ai_chat.message.code.executing') : copy('ai_chat.message.code.preview')}</span>
              </span>
            </Tooltip>
          )}
          <CodeCopyButton text={displayText} />
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        <SyntaxHighlighter
          style={darkMode ? vscDarkPlus as any : vs as any}
          language={language}
          PreTag="div"
          showLineNumbers
          customStyle={{
            margin: 0,
            borderRadius: 0,
            background: darkMode ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.02)',
            maxHeight: expanded ? 'none' : (isLongCode ? 300 : 'none'),
            overflowY: expanded ? 'auto' : 'hidden',
            fontSize: '14px',
            lineHeight: 1.6,
          }}
          codeTagProps={{
            style: {
              fontSize: '14px',
              fontFamily: 'var(--gn-font-mono)',
            },
          }}
        >
          {displayText}
        </SyntaxHighlighter>

        {!expanded && isLongCode && (
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 60,
              background: `linear-gradient(to bottom, transparent, ${darkMode ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)'})`,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              paddingBottom: 8,
              cursor: 'pointer',
            }}
            onClick={() => setExpanded(true)}
          >
            <span style={{ fontSize: 12, color: overlayTheme.iconColor, background: darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)', padding: '2px 8px', borderRadius: 12 }}>
              {copy('ai_chat.message.code.expand_all')}
            </span>
          </div>
        )}
        {expanded && isLongCode && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: '6px 0',
              background: darkMode ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.02)',
              cursor: 'pointer',
              borderTop: `1px solid ${darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'}`,
            }}
            onClick={() => setExpanded(false)}
          >
            <span style={{ fontSize: 12, color: overlayTheme.iconColor }}>{copy('ai_chat.message.code.collapse')}</span>
          </div>
        )}
      </div>

      {previewError && (
        <div style={{ padding: '8px 12px', fontSize: 12, color: '#ef4444', background: darkMode ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.05)', borderTop: `1px solid ${darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'}` }}>
          ❌ {previewError}
        </div>
      )}
      {previewExpanded && previewData && previewData.length > 0 && (
        <div style={{ borderTop: `1px solid ${darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 12px', background: darkMode ? 'rgba(250,173,20,0.08)' : 'rgba(250,173,20,0.05)' }}>
            <span style={{ fontSize: 11, color: overlayTheme.mutedText }}>📊 {copy('ai_chat.message.code.preview_result', { rows: previewData.length, columns: previewCols.length })}</span>
            <span style={{ fontSize: 11, color: overlayTheme.mutedText, cursor: 'pointer' }} onClick={() => setPreviewExpanded(false)}>{copy('ai_chat.message.code.preview_collapse')} ▴</span>
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 200, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--gn-font-mono)' }}>
              <thead>
                <tr>
                  {previewCols.map((column) => (
                    <th key={column} style={{ padding: '4px 8px', textAlign: 'left', background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: overlayTheme.titleText, fontWeight: 600, whiteSpace: 'nowrap', borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewData.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {previewCols.map((column) => (
                      <td key={column} style={{ padding: '3px 8px', color: overlayTheme.mutedText, whiteSpace: 'nowrap', borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'}`, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row[column] === null ? <span style={{ color: '#999', fontStyle: 'italic' }}>NULL</span> : String(row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!previewExpanded && previewData && previewData.length > 0 && (
        <div
          style={{ padding: '4px 12px', cursor: 'pointer', fontSize: 11, color: overlayTheme.mutedText, background: darkMode ? 'rgba(250,173,20,0.05)' : 'rgba(250,173,20,0.03)', borderTop: `1px solid ${darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'}` }}
          onClick={() => setPreviewExpanded(true)}
        >
          📊 {copy('ai_chat.message.code.view_result', { rows: previewData.length })} ▾
        </div>
      )}
    </div>
  );
};

export const AIMessageCodeBlock: React.FC<AIMessageCodeBlockProps> = ({
  className,
  inline,
  children,
  darkMode,
  overlayTheme,
  activeConnectionConfig,
  activeConnectionId,
  activeDbName,
}) => {
  const match = /language-(\w+)/.exec(className || '');
  if (!inline && match && match[1] === 'mermaid') {
    return <MermaidRenderer chart={String(children).replace(/\n$/, '')} darkMode={darkMode} />;
  }

  if (!inline && match) {
    const codeText = String(children).replace(/\n$/, '');
    const displayText = codeText.replace(/^--\s*@context\s+.*\n?/gm, '').trim();

    return (
      <HighlightedCodeBlock
        language={match[1]}
        codeText={codeText}
        displayText={displayText}
        darkMode={darkMode}
        overlayTheme={overlayTheme}
        activeConnectionConfig={activeConnectionConfig}
        activeConnectionId={activeConnectionId}
        activeDbName={activeDbName}
      />
    );
  }

  return <code className={className}>{children}</code>;
};
