import React, { useEffect, useRef, useState } from 'react';
import { t, type I18nParams } from '../../i18n';
import { Alert, Segmented } from 'antd';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { ensureMonacoConfigured } from '../MonacoEditor';
import { registerGonaviMonacoThemes } from '../monacoThemes';
import { useStore } from '../../store';

const NacosHistoryDiff: React.FC<{
  original: string; modified: string; language: string; onMount?: DiffOnMount;
  tr?: (key: string, params?: I18nParams) => string;
}> = ({ original, modified, language, onMount, tr = t }) => {
  const [view, setView] = useState<'inline' | 'split'>('inline');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [noChanges, setNoChanges] = useState(false);
  const subscriptionRef = useRef<{ dispose(): void } | null>(null);
  useEffect(() => { setNoChanges(false); }, [original, modified]);
  useEffect(() => () => { subscriptionRef.current?.dispose(); }, []);
  const theme = useStore(state => state.theme);
  useEffect(() => {
    let cancelled = false;
    void ensureMonacoConfigured().then(() => { if (!cancelled) setReady(true); })
      .catch(reason => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, []);
  if (error) return <div role="alert">{error}</div>;
  if (!ready) return null;
  return <>
    <Segmented
      aria-label={tr('nacos.history.diff_view')}
      value={view}
      options={[{ value: 'inline', label: tr('nacos.history.inline_diff') },
        { value: 'split', label: tr('nacos.history.split_diff') }]}
      onChange={(value) => setView(value === 'split' ? 'split' : 'inline')}
    />
    {noChanges ? <Alert type="success" showIcon role="status"
      message={tr('nacos.history.no_changes_title')}
      description={tr('nacos.history.no_changes')} /> : null}
    {view === 'split' ? (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <strong>{tr('nacos.history.historical_content')}</strong>
        <strong>{tr('nacos.history.current_published_content')}</strong>
      </div>
    ) : null}
    <DiffEditor height={360} original={original} modified={modified} language={language}
    theme={theme === 'dark' ? 'transparent-dark' : 'transparent-light'}
    beforeMount={registerGonaviMonacoThemes} onMount={(editor, monaco) => {
      subscriptionRef.current?.dispose();
      const update = () => {
        const changes = editor.getLineChanges();
        if (changes !== null) setNoChanges(changes.length === 0);
      };
      subscriptionRef.current = editor.onDidUpdateDiff(update);
      update();
      onMount?.(editor, monaco);
    }}
    options={{
      readOnly: true, originalEditable: false, renderSideBySide: view === 'split',
      useInlineViewWhenSpaceIsLimited: false, enableSplitViewResizing: true,
      renderIndicators: true, renderMarginRevertIcon: false, renderGutterMenu: false,
      ignoreTrimWhitespace: false, diffAlgorithm: 'advanced',
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 10 },
      minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false,
      lineNumbers: 'on', wordWrap: 'on', renderOverviewRuler: false,
    }} />
  </>;
};
export default NacosHistoryDiff;
