import type { TabData } from '../types';

// Query editors stay mounted while their tab is hidden. Unmounting disposes
// Monaco, and creating a new editor always starts at the top of the file.
// A real tab close still unmounts the editor, which is what rolls a managed
// transaction back.
export const shouldDestroyHiddenWorkbenchTab = (
  _tab: Pick<TabData, 'id' | 'type'>,
  _pendingTransactions?: Record<string, unknown> | null,
  _hasPendingResultChanges = false,
): boolean => false;

export const shouldBlockWorkbenchTabDetach = (
  tab: Pick<TabData, 'type'>,
  hasPendingResultChanges: boolean,
): boolean => tab.type === 'query' && hasPendingResultChanges;
