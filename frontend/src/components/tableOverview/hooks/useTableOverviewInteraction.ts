import { useCallback, useRef } from 'react';

import type { TabData } from '../../../types';
import type { TableOverviewStateApi } from './useTableOverviewState';
import type { TableOverviewTableActionsApi } from './useTableOverviewTableActions';
import { useTableOverviewSelection } from './useTableOverviewSelection';
import { useTableOverviewInlineRename } from './useTableOverviewInlineRename';
import { useTableOverviewClipboard } from './useTableOverviewClipboard';

type UseTableOverviewInteractionInput = {
  tab: TabData;
  state: TableOverviewStateApi;
  actions: TableOverviewTableActionsApi;
};

export const useTableOverviewInteraction = ({ tab, state, actions }: UseTableOverviewInteractionInput) => {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<{ names: string[]; setSelection: (names: string[]) => void }>({
    names: [], setSelection: () => {},
  });
  const rename = useTableOverviewInlineRename({
    commitRename: actions.commitTableRename,
    onRenamed: (previousName, newName) => {
      const current = selectionRef.current;
      if (current.names.includes(previousName)) current.setSelection([newName]);
    },
  });
  const selection = useTableOverviewSelection({ contentRef, onActivateName: rename.startRename });
  selectionRef.current = { names: selection.selectedNames, setSelection: selection.setSelection };
  useTableOverviewClipboard({
    rootRef: contentRef, selectedNames: selection.selectedNames, tab, connection: state.connection,
    schemaName: state.overviewSchemaName || state.schemaName,
    activeShortcutPlatform: state.activeShortcutPlatform, loadData: state.loadData,
    blocked: state.loading || Boolean(state.v2ContextMenu),
  });
  const openTableByDefaultAction = useCallback((tableName: string) => {
    if (!rename.renamingTable) state.openTableByDefaultAction(tableName);
  }, [rename.renamingTable, state.openTableByDefaultAction]);

  return { contentRef, rename, selection, openTableByDefaultAction };
};
