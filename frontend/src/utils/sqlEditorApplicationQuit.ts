import type { SavedQuery, TabData } from '../types';
import { ReadSQLFile, WriteSQLFile } from '../../wailsjs/go/app/App';
import {
  getSQLFileTabPath,
  hasSQLFileTabUnsavedChanges,
  isSQLFileMissingReadResult,
  isSQLFileQueryTab,
  normalizeSQLFileReadContent,
} from './sqlFileTabDirty';
import {
  clearQueryTabDraft,
  getQueryTabDraft,
  getSQLFileTabDraft,
} from './sqlFileTabDrafts';

type QueryResultLike = {
  success?: boolean;
  message?: string;
  data?: unknown;
};

export type ApplicationQuitUnsavedSQLTarget =
  | {
      kind: 'sql-file';
      tabId: string;
      title: string;
      filePath: string;
      draft: string;
    }
  | {
      kind: 'saved-query';
      tabId: string;
      title: string;
      savedQuery: SavedQuery;
      draft: string;
      connectionId: string;
      dbName: string;
    }
  | {
      kind: 'unsaved-query';
      tabId: string;
      title: string;
      draft: string;
      connectionId: string;
      dbName: string;
    };

export type ReadSQLFileForQuit = (filePath: string) => Promise<QueryResultLike>;
export type WriteSQLFileForQuit = (filePath: string, content: string) => Promise<QueryResultLike>;
export type SaveQueryForQuit = (query: SavedQuery) => Promise<SavedQuery>;

export type ApplicationQuitSavedSQLTarget = {
  target: ApplicationQuitUnsavedSQLTarget;
  savedQuery?: SavedQuery;
};

type ApplicationQuitSQLStateSnapshot = {
  tabs: TabData[];
  savedQueries: SavedQuery[];
};

type SaveLatestApplicationQuitUnsavedSQLStateArgs = {
  getState: () => ApplicationQuitSQLStateSnapshot;
  updateTabs: (update: (tabs: TabData[]) => TabData[]) => void;
  saveQuery: SaveQueryForQuit;
  readSQLFile?: ReadSQLFileForQuit;
  writeSQLFile?: WriteSQLFileForQuit;
};

const toTrimmedString = (value: unknown): string => String(value ?? '').trim();

const resolveTabTitle = (tab: TabData, fallback: string): string =>
  toTrimmedString(tab.title) || fallback;

const resolveSavedQueryForTab = (
  tab: TabData,
  savedQueries: SavedQuery[],
): SavedQuery | null => {
  if (tab.type !== 'query' || isSQLFileQueryTab(tab)) return null;
  const savedId = toTrimmedString(tab.savedQueryId) || toTrimmedString(tab.id);
  if (!savedId) return null;
  return savedQueries.find((query) => query.id === savedId) || null;
};

const hasSavedQueryUnsavedChanges = (
  tab: TabData,
  savedQuery: SavedQuery,
  draft: string,
): boolean => {
  const connectionId = toTrimmedString(tab.connectionId || savedQuery.connectionId);
  const dbName = toTrimmedString(tab.dbName || savedQuery.dbName);
  return draft !== String(savedQuery.sql ?? '')
    || connectionId !== toTrimmedString(savedQuery.connectionId)
    || dbName !== toTrimmedString(savedQuery.dbName);
};

export const buildApplicationQuitUnsavedSQLLabel = (
  targets: ApplicationQuitUnsavedSQLTarget[],
): string => {
  if (targets.length === 0) return '';
  if (targets.length === 1) return targets[0].title;
  return String(targets.length);
};

export const collectApplicationQuitUnsavedSQLTargets = async (
  tabs: TabData[],
  savedQueries: SavedQuery[],
  readSQLFile: ReadSQLFileForQuit = ReadSQLFile,
): Promise<ApplicationQuitUnsavedSQLTarget[]> => {
  const targets: ApplicationQuitUnsavedSQLTarget[] = [];

  for (const tab of tabs) {
    if (tab.type !== 'query') continue;

    if (isSQLFileQueryTab(tab)) {
      const filePath = getSQLFileTabPath(tab);
      const draft = getSQLFileTabDraft(tab.id, String(tab.query ?? ''));
      const title = resolveTabTitle(tab, filePath);
      try {
        const res = await readSQLFile(filePath);
        if (res?.success) {
          if (hasSQLFileTabUnsavedChanges({ ...tab, query: draft }, normalizeSQLFileReadContent(res.data))) {
            targets.push({ kind: 'sql-file', tabId: tab.id, title, filePath, draft });
          }
          continue;
        }
        if (isSQLFileMissingReadResult(res)) {
          targets.push({ kind: 'sql-file', tabId: tab.id, title, filePath, draft });
          continue;
        }
        throw new Error(res?.message || filePath);
      } catch {
        targets.push({ kind: 'sql-file', tabId: tab.id, title, filePath, draft });
      }
      continue;
    }

    const draft = getQueryTabDraft(tab.id, String(tab.query ?? ''));
    const savedQuery = resolveSavedQueryForTab(tab, savedQueries);
    if (!savedQuery) {
      if (!draft.trim()) continue;
      targets.push({
        kind: 'unsaved-query',
        tabId: tab.id,
        title: resolveTabTitle(tab, 'SQL Query'),
        draft,
        connectionId: toTrimmedString(tab.connectionId),
        dbName: toTrimmedString(tab.dbName),
      });
      continue;
    }
    if (!hasSavedQueryUnsavedChanges(tab, savedQuery, draft)) continue;
    targets.push({
      kind: 'saved-query',
      tabId: tab.id,
      title: resolveTabTitle(tab, savedQuery.name),
      savedQuery,
      draft,
      connectionId: toTrimmedString(tab.connectionId || savedQuery.connectionId),
      dbName: toTrimmedString(tab.dbName || savedQuery.dbName),
    });
  }

  return targets;
};

export const saveApplicationQuitUnsavedSQLTargets = async (
  targets: ApplicationQuitUnsavedSQLTarget[],
  saveQuery: SaveQueryForQuit,
  writeSQLFile: WriteSQLFileForQuit = WriteSQLFile,
): Promise<ApplicationQuitSavedSQLTarget[]> => {
  const savedTargets: ApplicationQuitSavedSQLTarget[] = [];
  for (const target of targets) {
    if (target.kind === 'sql-file') {
      const res = await writeSQLFile(target.filePath, target.draft);
      if (!res?.success) {
        throw new Error(res?.message || target.filePath);
      }
      savedTargets.push({ target });
      continue;
    }

    if (target.kind === 'saved-query') {
      const savedQuery = await saveQuery({
        ...target.savedQuery,
        sql: target.draft,
        connectionId: target.connectionId,
        dbName: target.dbName,
      });
      savedTargets.push({ target, savedQuery });
      continue;
    }

    const savedQuery = await saveQuery({
      // Keep the tab identity so a restored tab resolves this saved query on
      // later exits instead of creating a new history copy every time.
      id: target.tabId,
      name: target.title,
      sql: target.draft,
      connectionId: target.connectionId,
      dbName: target.dbName,
      createdAt: Date.now(),
    });
    savedTargets.push({ target, savedQuery });
  }
  return savedTargets;
};

export const reconcileApplicationQuitSavedSQLTargets = (
  tabs: TabData[],
  savedTargets: ApplicationQuitSavedSQLTarget[],
): TabData[] => {
  const savedByTabId = new Map(
    savedTargets.map((savedTarget) => [savedTarget.target.tabId, savedTarget]),
  );
  return tabs.map((tab) => {
    const savedTarget = savedByTabId.get(tab.id);
    if (!savedTarget) return tab;

    if (savedTarget.target.kind === 'sql-file') {
      return {
        ...tab,
        query: savedTarget.target.draft,
      };
    }

    const savedQuery = savedTarget.savedQuery;
    if (!savedQuery) return tab;
    return {
      ...tab,
      title: savedQuery.name,
      query: savedQuery.sql,
      connectionId: savedQuery.connectionId,
      dbName: savedQuery.dbName,
      savedQueryId: savedQuery.id,
    };
  });
};

export const assertApplicationQuitSavedSQLTargetsUnchanged = (
  savedTargets: ApplicationQuitSavedSQLTarget[],
): void => {
  const changedWhileSaving = savedTargets.find(({ target }) => (
    getQueryTabDraft(target.tabId, target.draft) !== target.draft
  ));
  if (changedWhileSaving) {
    throw new Error(`SQL changed while saving: ${changedWhileSaving.target.title}`);
  }
};

export const saveLatestApplicationQuitUnsavedSQLState = async ({
  getState,
  updateTabs,
  saveQuery,
  readSQLFile = ReadSQLFile,
  writeSQLFile = WriteSQLFile,
}: SaveLatestApplicationQuitUnsavedSQLStateArgs): Promise<ApplicationQuitSavedSQLTarget[]> => {
  const latestState = getState();
  const targets = await collectApplicationQuitUnsavedSQLTargets(
    latestState.tabs,
    latestState.savedQueries,
    readSQLFile,
  );
  const savedTargets = await saveApplicationQuitUnsavedSQLTargets(
    targets,
    saveQuery,
    writeSQLFile,
  );

  assertApplicationQuitSavedSQLTargetsUnchanged(savedTargets);

  updateTabs((tabs) => reconcileApplicationQuitSavedSQLTargets(tabs, savedTargets));
  savedTargets.forEach(({ target }) => clearQueryTabDraft(target.tabId));
  return savedTargets;
};
