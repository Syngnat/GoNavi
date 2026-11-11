import { lazy, Suspense, useRef, type ReactNode } from 'react';
import { Input } from 'antd';
import { useOptionalI18n } from '../../../../i18n/provider';
import { t as defaultTranslate } from '../../../../i18n';
import QueryEditorToolbar from '../../../QueryEditorToolbar';
import { comboToMonacoKeyBinding } from '../../../../utils/shortcuts';
import { useLivePreviewQueryControls } from './useLivePreviewQueryControls';
const MonacoEditor = lazy(() => import('../../../MonacoEditor'));

type Props = { value: string; connectionName?: string; onChange: (sql: string) => void; onRun: (sql: string) => void; onStatus?: (status: string) => void; children?: ReactNode };
export function LivePreviewEditor({ value, connectionName = 'Demo · MySQL', onChange, onRun, onStatus = () => undefined, children }: Props) {
  const t = useOptionalI18n()?.t ?? defaultTranslate;
  const controls = useLivePreviewQueryControls({ value, connectionName, onChange, onRun, onStatus });
  const toolbarRef = useRef(controls.toolbar);
  toolbarRef.current = controls.toolbar;
  return <section className="gn-v2-query-editor gn-live-query-workbench">
    <div className={`gn-v2-query-editor-pane gn-live-editor${controls.fullscreen || !controls.resultsVisible ? ' is-expanded' : ''}`}>
      <QueryEditorToolbar {...controls.toolbar} />
      <div className="gn-v2-query-monaco-stage gn-live-editor-input"><div className="gn-v2-query-monaco-shell gn-live-editor-input">
      <Suspense fallback={<Input.TextArea aria-label={t('settings.preview.sql')} value={value} onChange={event => onChange(event.target.value)} />}>
        <MonacoEditor gonaviTypography="sql" language="sql" value={value} height="100%" onChange={next => onChange(next || '')}
          options={{ automaticLayout: true, minimap: { enabled: false }, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: controls.wordWrap ? 'on' : 'off', ariaLabel: t('settings.preview.sql') }}
          onMount={(editor, monaco) => {
            controls.editorRef.current = editor;
            const actions = [
              ['run', 'query_editor.action.run', 'runQueryShortcutBinding', 'onRun'],
              ['save', 'query_editor.action.save', 'saveQueryShortcutBinding', 'onQuickSave'],
              ['format', 'query_editor.action.format_sql', 'formatSqlShortcutBinding', 'onFormat'],
            ] as const;
            for (const [id, labelKey, bindingKey, actionKey] of actions) {
              const binding = toolbarRef.current[bindingKey];
              const key = binding.enabled ? comboToMonacoKeyBinding(binding.combo, monaco.KeyMod, monaco.KeyCode, toolbarRef.current.activeShortcutPlatform) : null;
              editor.addAction({ id: `preview-${id}`, label: t(labelKey), keybindings: key ? [key.keyMod | key.keyCode] : [], run: () => toolbarRef.current[actionKey]() });
            }
          }} />
      </Suspense>
      </div></div>
    </div>
    {controls.resultsVisible && !controls.fullscreen && children}
  </section>;
}
