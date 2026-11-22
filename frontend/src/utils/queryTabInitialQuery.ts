import type { TabData } from '../types';
import { hasQueryTabDraft, getQueryTabDraft } from './sqlFileTabDrafts';

export const DEFAULT_QUERY_TEMPLATE = 'SELECT * FROM ';

export const resolveNewQueryDefaultTemplate = (
  template: string | null | undefined,
): string => {
  if (template === null || template === undefined) {
    return DEFAULT_QUERY_TEMPLATE;
  }
  return String(template)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
};

export const getTabQueryValue = (tab: TabData): string => (
  typeof tab.query === 'string' ? tab.query : ''
);

export const getInitialEditorQuery = (
  tab: TabData,
  defaultQueryTemplate: string | null | undefined = DEFAULT_QUERY_TEMPLATE,
): string => {
  if (hasQueryTabDraft(tab.id)) {
    return getQueryTabDraft(tab.id);
  }
  const tabQuery = getTabQueryValue(tab);
  if (tabQuery || tab.filePath || tab.savedQueryId || tab.readOnly) {
    return tabQuery;
  }
  return resolveNewQueryDefaultTemplate(defaultQueryTemplate);
};
