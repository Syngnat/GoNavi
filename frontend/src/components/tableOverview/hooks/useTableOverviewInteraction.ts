import { useRef } from 'react';

import type { TabData } from '../../../types';
import type { TableOverviewStateApi } from './useTableOverviewState';
import { useTableOverviewSelection } from './useTableOverviewSelection';
import { useTableOverviewClipboard } from './useTableOverviewClipboard';

type UseTableOverviewInteractionInput = {
  tab: TabData;
  state: TableOverviewStateApi;
};

export const useTableOverviewInteraction = ({ tab, state }: UseTableOverviewInteractionInput) => {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const selection = useTableOverviewSelection({ contentRef });
  useTableOverviewClipboard({
    rootRef: contentRef, selectedNames: selection.selectedNames, tab, connection: state.connection,
    schemaName: state.overviewSchemaName || state.schemaName,
    activeShortcutPlatform: state.activeShortcutPlatform, loadData: state.loadData,
    blocked: state.loading || Boolean(state.v2ContextMenu),
  });

  return { contentRef, selection, openTableByDefaultAction: state.openTableByDefaultAction };
};
