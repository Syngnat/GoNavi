import { useEffect } from 'react';

import { EventsOn } from '../../../wailsjs/runtime';
import {
    openDroppedSqlFiles,
    sortSqlDropPaths,
} from '../../components/queryEditor/externalSqlFileDrop';
import {
    buildExternalSqlDropDeps,
    resolveExternalSqlDropContext,
} from '../../components/queryEditor/useExternalSqlFileDrop';

/**
 * Opens .sql files handed over by the operating system (file association or
 * "Open with"). Wails v3 reports these through the native opened-file event;
 * the desktop host forwards each path as `gonavi:open-file`. The same path is
 * used by drag-and-drop, so no second import implementation is needed.
 */
export const useFileAssociationOpen = (): void => {
    useEffect(() => {
        return EventsOn('gonavi:open-file', (payload?: { path?: string }) => {
            const filePath = String(payload?.path || '').trim();
            if (!/\.sql$/i.test(filePath)) {
                return;
            }
            void openDroppedSqlFiles(
                buildExternalSqlDropDeps(),
                sortSqlDropPaths([filePath]),
                resolveExternalSqlDropContext(),
            );
        });
    }, []);
};
