import React from 'react';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';

import {
  DEFAULT_AI_SLASH_COMMANDS,
  getFeaturedAISlashCommands,
  groupAISlashCommands,
  splitAISlashCommandIcon,
  type AISlashCommandDefinition,
} from './aiSlashCommands';

interface AISlashCommandMenuProps {
  visible: boolean;
  commands: AISlashCommandDefinition[];
  darkMode: boolean;
  textColor: string;
  mutedColor: string;
  /** The command the keyboard is on; it is highlighted and kept in view. */
  activeCmd?: string;
  className?: string;
  style?: React.CSSProperties;
  onSelect: (command: AISlashCommandDefinition) => void;
  onActiveChange?: (cmd: string) => void;
}

export const AISlashCommandMenu: React.FC<AISlashCommandMenuProps> = ({
  visible,
  commands,
  darkMode,
  textColor,
  mutedColor,
  activeCmd,
  className,
  style,
  onSelect,
  onActiveChange,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const groups = React.useMemo(() => groupAISlashCommands(commands, t), [commands, t]);
  const featuredCommands = React.useMemo(() => getFeaturedAISlashCommands(t), [t]);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!visible || !activeCmd) return;
    // Only the keyboard needs the row scrolled into view; hover never moves the list.
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeCmd, visible]);

  if (!visible) {
    return null;
  }

  const themeVars = {
    '--ai-slash-text': textColor,
    '--ai-slash-muted': mutedColor,
    '--ai-slash-border': darkMode ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)',
    '--ai-slash-active': darkMode ? 'rgba(255,255,255,0.09)' : 'rgba(22,119,255,0.09)',
    '--ai-slash-key': darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
  } as React.CSSProperties;

  return (
    <div
      data-ai-chat-slash-menu="true"
      className={`ai-slash-menu${className ? ` ${className}` : ''}`}
      style={{ ...themeVars, ...style }}
    >
      {groups.length > 0 ? (
        <>
          <div ref={listRef} className="ai-slash-scroll" role="listbox">
            {groups.map((group) => (
              <div key={group.key} data-ai-chat-slash-group={group.key} className="ai-slash-group">
                <div className="ai-slash-group-title" title={group.description}>{group.title}</div>
                {group.commands.map((command) => {
                  const { icon, text } = splitAISlashCommandIcon(command.label);
                  const active = command.cmd === activeCmd;
                  return (
                    <button
                      key={command.cmd}
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-active={active ? 'true' : 'false'}
                      className="ai-slash-item"
                      title={command.desc}
                      // Keep focus in the composer so the person can keep typing.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => onActiveChange?.(command.cmd)}
                      onClick={() => onSelect(command)}
                    >
                      <span className="ai-slash-icon" aria-hidden="true">{icon}</span>
                      <span className="ai-slash-cmd">{command.cmd}</span>
                      <span className="ai-slash-label">{text}</span>
                      <span className="ai-slash-desc">{command.desc}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="ai-slash-footer" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd>{t('ai_chat.input.slash.hint.navigate')}</span>
            <span><kbd>↵</kbd>{t('ai_chat.input.slash.hint.insert')}</span>
            <span><kbd>Esc</kbd>{t('ai_chat.input.slash.hint.close')}</span>
          </div>
        </>
      ) : (
        <div data-ai-chat-slash-empty="true" className="ai-slash-empty">
          <div className="ai-slash-empty-title">{t('ai_chat.input.slash.empty.title')}</div>
          <div className="ai-slash-empty-text">{t('ai_chat.input.slash.empty.description')}</div>
          <div className="ai-slash-empty-chips">
            {featuredCommands.map((command) => (
              <button
                key={command.cmd}
                type="button"
                className="ai-slash-chip"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(command)}
              >
                {command.cmd}
              </button>
            ))}
          </div>
          <div className="ai-slash-empty-text">
            {t('ai_chat.input.slash.empty.summary', { count: DEFAULT_AI_SLASH_COMMANDS.length })}
          </div>
        </div>
      )}
    </div>
  );
};

export default AISlashCommandMenu;
