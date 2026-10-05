import { QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER } from '../queryEditorRunHelpers';
import { injectQueryEditorAiPromptWithContext } from '../queryEditorAiPromptInject';
import type { OnMount } from '../../MonacoEditor';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';

export interface BindQueryEditorSlashCommandsInput {
    editor: Parameters<OnMount>[0];
    connectionsRef: React.MutableRefObject<SavedConnection[]>;
    currentConnectionIdRef: React.MutableRefObject<string>;
    getCurrentQuery: () => string;
    currentDbRef: React.MutableRefObject<string>;
}

export const bindQueryEditorSlashCommands = ({
    editor, connectionsRef, currentConnectionIdRef, getCurrentQuery, currentDbRef,
}: BindQueryEditorSlashCommandsInput) => {
    // end sqlCompletionRegistered guard

         // 每个编辑器实例都注册内容变化监听（检测斜杠命令标记）
         let _handlingSlash = false;
         editor.onDidChangeModelContent((event: any) => {
             if (_handlingSlash) return;
             const hasSlashCommandMarker = Array.isArray(event?.changes)
                 && event.changes.some((change: any) => /__AI_\w+__/.test(String(change?.text || '')));
             if (!hasSlashCommandMarker) return;
             const model = editor.getModel();
             if (!model) return;
             const content = model.getValue();
             const markerMatch = content.match(/__AI_(\w+)__/);
             if (!markerMatch) return;

             const cmdKey = markerMatch[1].toLowerCase();
             const defs = (window as any).__gonaviSlashCmdDefs || [];
             const cmdDef = defs.find((c: any) => c.cmd === `/${cmdKey}`);
             if (!cmdDef) return;

             // 清除标记文本（带递归保护）
             _handlingSlash = true;
             const fullText = model.getValue();
             const newText = fullText.replace(markerMatch[0], '').replace(/^\s*\n/, '');
             model.setValue(newText);
             _handlingSlash = false;

             const conn = connectionsRef.current.find(c => c.id === currentConnectionIdRef.current);
             let prompt = cmdDef.prompt;
             if (cmdDef.useSelection) {
                 const sel = editor.getSelection();
                 const selText = sel ? model.getValueInRange(sel) : '';
                 prompt = prompt.replace(QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER, selText || getCurrentQuery());
             }
             void injectQueryEditorAiPromptWithContext({
                 connection: conn,
                 database: currentDbRef.current,
                 prompt,
                 delayIfPanelClosedMs: 350,
             });
         });
};
