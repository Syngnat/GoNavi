import type {
  SaveScriptInput,
  ScriptLibraryFolder,
  ScriptLibraryScript,
  ScriptVisibility,
  ScriptWorkbenchAdapter,
} from './scriptWorkbenchTypes';
import {
  SCRIPT_RUN_LIMITS,
  SCRIPT_STARTER_SOURCE,
} from './scriptWorkbenchUtils';

export const createLibraryScript = async ({
  adapter,
  name,
  visibility,
  folderId,
}: {
  adapter: ScriptWorkbenchAdapter;
  name: string;
  visibility: ScriptVisibility;
  folderId?: string;
}): Promise<ScriptLibraryScript> => adapter.saveScript({
  name,
  code: SCRIPT_STARTER_SOURCE,
  visibility,
  folderId,
  connections: [],
  inputs: [],
  allowWrite: false,
  batchSize: SCRIPT_RUN_LIMITS.defaultBatch,
  inListLimit: SCRIPT_RUN_LIMITS.defaultInList,
  revision: 0,
});

export const renameLibraryScript = async ({
  adapter,
  scriptId,
  name,
  script,
}: {
  adapter: ScriptWorkbenchAdapter;
  scriptId: string;
  name: string;
  script?: ScriptLibraryScript;
}): Promise<ScriptLibraryScript> => {
  const current = script || await adapter.getScript(scriptId);
  const input: SaveScriptInput = {
    id: current.id,
    name,
    description: current.description,
    code: current.code,
    visibility: current.visibility,
    folderId: current.folderId,
    connections: current.connections || [],
    inputs: current.inputs || [],
    allowWrite: current.allowWrite,
    batchSize: current.batchSize,
    inListLimit: current.inListLimit,
    ...(current.runLimits ? { runLimits: current.runLimits } : {}),
    revision: current.revision,
  };
  return adapter.saveScript(input);
};

export const duplicateLibraryScript = async ({
  adapter,
  scriptId,
  suffix,
}: {
  adapter: ScriptWorkbenchAdapter;
  scriptId: string;
  suffix: string;
}): Promise<ScriptLibraryScript> => {
  const current = await adapter.getScript(scriptId);
  return adapter.saveScript({
    name: `${current.name} ${suffix}`.trim(),
    description: current.description,
    code: current.code,
    visibility: current.visibility,
    folderId: current.folderId,
    connections: current.connections || [],
    inputs: current.inputs || [],
    allowWrite: current.allowWrite,
    batchSize: current.batchSize,
    inListLimit: current.inListLimit,
    ...(current.runLimits ? { runLimits: current.runLimits } : {}),
    revision: 0,
  });
};

export const createLibraryFolder = async ({
  adapter,
  name,
  visibility,
  parentId,
}: {
  adapter: ScriptWorkbenchAdapter;
  name: string;
  visibility: ScriptVisibility;
  parentId?: string;
}): Promise<ScriptLibraryFolder> => adapter.saveFolder({
  name,
  parentId,
  visibility,
  revision: 0,
});
