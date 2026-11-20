import { useEffect, useRef, type RefObject } from 'react';
import {
  isEditableElement,
  isShortcutMatch,
  resolveShortcutBinding,
  SHORTCUT_ACTION_META,
  type ShortcutOptions,
  type ShortcutPlatform,
} from '../../utils/shortcuts';

export type ScriptWorkbenchShortcutAction =
  | 'scriptWorkbenchRun'
  | 'scriptWorkbenchCancel'
  | 'scriptWorkbenchSave'
  | 'scriptWorkbenchLibrary'
  | 'scriptWorkbenchSettings'
  | 'scriptWorkbenchShare'
  | 'scriptWorkbenchAI';

const SCRIPT_WORKBENCH_SHORTCUT_ACTIONS: ScriptWorkbenchShortcutAction[] = [
  'scriptWorkbenchRun',
  'scriptWorkbenchCancel',
  'scriptWorkbenchSave',
  'scriptWorkbenchLibrary',
  'scriptWorkbenchSettings',
  'scriptWorkbenchShare',
  'scriptWorkbenchAI',
];

interface UseScriptWorkbenchShortcutsArgs {
  isActive: boolean;
  rootRef: RefObject<HTMLElement | null>;
  shortcutOptions: Partial<ShortcutOptions> | null | undefined;
  activeShortcutPlatform: ShortcutPlatform;
  disabled?: boolean;
  actions: Record<ScriptWorkbenchShortcutAction, () => void>;
}

export const useScriptWorkbenchShortcuts = ({
  isActive,
  rootRef,
  shortcutOptions,
  activeShortcutPlatform,
  disabled = false,
  actions,
}: UseScriptWorkbenchShortcutsArgs): void => {
  const scopeRef = useRef({
    isActive,
    rootRef,
    shortcutOptions,
    activeShortcutPlatform,
    disabled,
    actions,
  });
  scopeRef.current = {
    isActive,
    rootRef,
    shortcutOptions,
    activeShortcutPlatform,
    disabled,
    actions,
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      const scope = scopeRef.current;
      if (!scope.isActive || scope.disabled) {
        return;
      }

      const targetNode = event.target instanceof Node ? event.target : null;
      const insideWorkbench = Boolean(targetNode && scope.rootRef.current?.contains(targetNode));
      if (isEditableElement(event.target) && !insideWorkbench) {
        return;
      }

      for (const action of SCRIPT_WORKBENCH_SHORTCUT_ACTIONS) {
        const binding = resolveShortcutBinding(
          scope.shortcutOptions,
          action,
          scope.activeShortcutPlatform,
        );
        if (!binding.enabled || !binding.combo || !isShortcutMatch(event, binding.combo)) {
          continue;
        }
        const meta = SHORTCUT_ACTION_META[action];
        if (isEditableElement(event.target) && !meta.allowInEditable) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        scope.actions[action]();
        return;
      }
    };

    window.addEventListener('keydown', handleShortcut, true);
    return () => {
      window.removeEventListener('keydown', handleShortcut, true);
    };
  }, []);
};
