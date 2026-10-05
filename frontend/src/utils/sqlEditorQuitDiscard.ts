import type { TabData } from '../types';
import { useStore } from '../store';
import {
  collectApplicationQuitUnsavedSQLTargets,
  type ApplicationQuitUnsavedSQLTarget,
  type ReadSQLFileForQuit,
} from './sqlEditorApplicationQuit';
import { isSQLFileMissingReadResult, normalizeSQLFileReadContent } from './sqlFileTabDirty';
import { clearQueryTabDraft } from './sqlFileTabDrafts';
import { ReadSQLFile } from '../../wailsjs/go/app/App';

/**
 * "Quit and discard unsaved changes" has to discard them. Quitting persists the tabs and their
 * drafts so they come back after a restart; without this, the very edits the person chose to
 * throw away came back too, and every later quit asked about them again although nothing had
 * been touched since.
 *
 * Each tab the quit prompt listed goes back to what is saved:
 * - a saved query: its saved text, connection and database;
 * - an SQL file: what is on disk (if the file cannot be read, the tab is left as it is: there is
 *   nothing to go back to, and losing the text would be worse than being asked again);
 * - a new query that was never saved: emptied, so it is not restored.
 *
 * Returns how many tabs were reverted. It never rejects: quitting must not depend on it.
 */
export const discardApplicationQuitUnsavedSQLChanges = async (
  readSQLFile: ReadSQLFileForQuit = ReadSQLFile,
): Promise<number> => {
  try {
    const { tabs, savedQueries } = useStore.getState();
    const targets = await collectApplicationQuitUnsavedSQLTargets(tabs, savedQueries, readSQLFile);
    if (targets.length === 0) return 0;

    const reverted = new Map<string, Partial<TabData>>();
    for (const target of targets) {
      const patch = await revertedTabFields(target, readSQLFile);
      if (patch) reverted.set(target.tabId, patch);
    }
    if (reverted.size === 0) return 0;

    reverted.forEach((_patch, tabId) => clearQueryTabDraft(tabId));
    useStore.setState((state) => ({
      tabs: state.tabs.map((tab) => {
        const patch = reverted.get(tab.id);
        return patch ? { ...tab, ...patch, formatRestoreSnapshot: undefined } : tab;
      }),
    }));
    return reverted.size;
  } catch {
    return 0;
  }
};

const revertedTabFields = async (
  target: ApplicationQuitUnsavedSQLTarget,
  readSQLFile: ReadSQLFileForQuit,
): Promise<Partial<TabData> | null> => {
  switch (target.kind) {
    case 'saved-query':
      return {
        query: String(target.savedQuery.sql ?? ''),
        connectionId: target.savedQuery.connectionId,
        dbName: target.savedQuery.dbName,
      };
    case 'unsaved-query':
      return { query: '' };
    case 'sql-file': {
      try {
        const result = await readSQLFile(target.filePath);
        if (result?.success) return { query: normalizeSQLFileReadContent(result.data) };
        if (isSQLFileMissingReadResult(result)) return null;
      } catch {
        // Unreadable: keep the text (see above).
      }
      return null;
    }
    default:
      return null;
  }
};
