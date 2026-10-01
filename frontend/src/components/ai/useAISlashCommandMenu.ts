import React from 'react';

import {
  filterAISlashCommands,
  orderAISlashCommandsForDisplay,
  type AISlashCommandDefinition,
  type AISlashCommandTranslate,
} from './aiSlashCommands';

interface UseAISlashCommandMenuParams {
  setInput: (val: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  translate?: AISlashCommandTranslate;
}

export const useAISlashCommandMenu = ({
  setInput,
  textareaRef,
  translate,
}: UseAISlashCommandMenuParams) => {
  const [showSlashMenu, setShowSlashMenu] = React.useState(false);
  const [slashFilter, setSlashFilter] = React.useState('');
  const [activeCmd, setActiveCmd] = React.useState('');

  const filteredSlashCmds = React.useMemo(
    () => filterAISlashCommands(slashFilter, translate),
    [slashFilter, translate],
  );
  // Arrow keys walk the commands in the order the menu draws them.
  const orderedSlashCmds = React.useMemo(
    () => orderAISlashCommandsForDisplay(filteredSlashCmds, translate),
    [filteredSlashCmds, translate],
  );
  const highlightedCmd = orderedSlashCmds.find((command) => command.cmd === activeCmd) || orderedSlashCmds[0];

  const hideSlashMenu = React.useCallback(() => {
    setShowSlashMenu(false);
    setSlashFilter('');
    setActiveCmd('');
  }, []);

  const handleComposerInputChange = React.useCallback((value: string) => {
    setInput(value);
    // The menu is for picking a command: once a space follows it the person is
    // writing the request itself, and Enter must send it.
    if (value.startsWith('/') && !/\s/u.test(value)) {
      setSlashFilter(value);
      setActiveCmd('');
      setShowSlashMenu(true);
      return;
    }
    hideSlashMenu();
  }, [hideSlashMenu, setInput]);

  const handleSelectSlashCommand = React.useCallback((command: AISlashCommandDefinition) => {
    setInput(command.prompt);
    hideSlashMenu();
    textareaRef.current?.focus();
  }, [hideSlashMenu, setInput, textareaRef]);

  const handleOpenSlashMenu = React.useCallback(() => {
    setInput('/');
    setSlashFilter('/');
    setActiveCmd('');
    setShowSlashMenu(true);
    textareaRef.current?.focus();
  }, [setInput, textareaRef]);

  /** Returns true when the key belonged to the menu and must not reach the composer. */
  const handleSlashKeyDown = React.useCallback((event: React.KeyboardEvent): boolean => {
    if (!showSlashMenu || event.nativeEvent?.isComposing) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      hideSlashMenu();
      return true;
    }
    if (orderedSlashCmds.length === 0) return false;
    const index = Math.max(0, orderedSlashCmds.indexOf(highlightedCmd));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveCmd(orderedSlashCmds[(index + step + orderedSlashCmds.length) % orderedSlashCmds.length].cmd);
      return true;
    }
    const plainEnter = event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (plainEnter || event.key === 'Tab') {
      event.preventDefault();
      handleSelectSlashCommand(highlightedCmd);
      return true;
    }
    return false;
  }, [handleSelectSlashCommand, highlightedCmd, hideSlashMenu, orderedSlashCmds, showSlashMenu]);

  return {
    activeSlashCmd: showSlashMenu ? highlightedCmd?.cmd : undefined,
    filteredSlashCmds,
    handleComposerInputChange,
    handleOpenSlashMenu,
    handleSelectSlashCommand,
    handleSlashKeyDown,
    hideSlashMenu,
    setActiveSlashCmd: setActiveCmd,
    showSlashMenu,
    slashFilter,
  };
};
