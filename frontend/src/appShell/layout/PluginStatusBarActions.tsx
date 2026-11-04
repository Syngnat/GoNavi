import React from 'react';
import { usePluginStatusBarEntries } from '../hooks/usePluginStatusBarEntries';

/** Status-bar entries declared by running plugins through `navigation.location: "statusbar"`. */
export const PluginStatusBarActions = () => {
  const { entries, open } = usePluginStatusBarEntries();
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          className="gn-app-statusbar-action"
          title={entry.title}
          onClick={() => { void open(entry); }}
        >
          <span>{entry.title}</span>
        </button>
      ))}
    </>
  );
};

export default PluginStatusBarActions;
