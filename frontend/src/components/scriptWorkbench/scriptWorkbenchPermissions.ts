import type {
  ScriptLibraryFolder,
  ScriptLibraryScript,
  ScriptLibrarySnapshot,
} from './scriptWorkbenchTypes';

const ownerMatches = (
  snapshot: ScriptLibrarySnapshot | null | undefined,
  owner: string | undefined,
): boolean => (
  Boolean(owner)
  && Boolean(snapshot?.owner)
  && owner === snapshot?.owner
);

const fallbackCanEdit = (
  snapshot: ScriptLibrarySnapshot | null | undefined,
  item: Pick<ScriptLibraryScript, 'owner' | 'visibility'>,
): boolean => (
  snapshot?.canWrite === true
  && (
    ownerMatches(snapshot, item.owner)
    || (item.visibility === 'shared' && snapshot?.canManageShared === true)
  )
);

export const canEditScriptItem = (
  snapshot: ScriptLibrarySnapshot | null | undefined,
  script: ScriptLibraryScript,
): boolean => (
  script.canEdit === true
  || (script.canEdit === undefined && fallbackCanEdit(snapshot, script))
);

export const canShareScriptItem = (
  snapshot: ScriptLibrarySnapshot | null | undefined,
  script: ScriptLibraryScript,
): boolean => (
  snapshot?.canShare === true
  && (
    script.canShare === true
    || (script.canShare === undefined && (
      script.canEdit ?? fallbackCanEdit(snapshot, script)
    ))
  )
);

export const canEditFolderItem = (
  snapshot: ScriptLibrarySnapshot | null | undefined,
  folder: ScriptLibraryFolder,
): boolean => (
  folder.canEdit === true
  || (folder.canEdit === undefined && fallbackCanEdit(snapshot, folder))
);

export const canShareFolderItem = (
  snapshot: ScriptLibrarySnapshot | null | undefined,
  folder: ScriptLibraryFolder,
): boolean => (
  snapshot?.canShare === true
  && (
    folder.canShare === true
    || (folder.canShare === undefined && (
      folder.canEdit ?? fallbackCanEdit(snapshot, folder)
    ))
  )
);
