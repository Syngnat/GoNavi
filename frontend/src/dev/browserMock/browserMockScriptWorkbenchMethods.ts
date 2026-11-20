import { t } from '../../i18n';
import { SCRIPT_STARTER_SOURCE } from '../../components/scriptWorkbench/scriptWorkbenchUtils';

type MockScript = {
  id: string;
  name: string;
  description?: string;
  code: string;
  owner: string;
  visibility: 'private' | 'shared';
  folderId?: string;
  connections: Array<{ alias: string; connectionId?: string; database?: string }>;
  inputs: Array<Record<string, unknown>>;
  allowWrite: boolean;
  batchSize: number;
  inListLimit: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

type MockFolder = {
  id: string;
  name: string;
  parentId?: string;
  owner: string;
  visibility: 'private' | 'shared';
  revision: number;
  createdAt: number;
  updatedAt: number;
};

type MockRun = {
  runId: string;
  scriptId?: string;
  title?: string;
  status: string;
  stage?: string;
  startedAt: number;
  finishedAt?: number;
  cancelled?: boolean;
  timedOut?: boolean;
  memoryExceeded?: boolean;
  error?: string;
  dbCalls?: number;
  maxDbCalls: number;
  progress?: Record<string, unknown>;
  logs: Array<{ timestamp: number; level: string; message: string }>;
  outputs: Array<{ index: number; name: string; columns: string[]; rowCount: number; truncated?: boolean }>;
  rows: Array<Record<string, unknown>>;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const now = () => Date.now();
const nextId = (prefix: string) => `${prefix}-${now()}-${Math.random().toString(36).slice(2, 7)}`;

export const createBrowserMockScriptWorkbenchMethods = () => {
  let initialized = false;
  let folders: MockFolder[] = [];
  let scripts: MockScript[] = [];
  const runs = new Map<string, MockRun>();
  const timers = new Map<string, number[]>();

  const initialize = () => {
    if (initialized) return;
    initialized = true;
    const createdAt = now() - 300_000;
    folders = [
      {
        id: 'script-folder-private',
        name: t('script_workbench.demo.folder.private'),
        owner: 'local',
        visibility: 'private',
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'script-folder-shared',
        name: t('script_workbench.demo.folder.shared'),
        owner: 'local',
        visibility: 'shared',
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      },
    ];
    scripts = [
      {
        id: 'script-demo-batch',
        name: t('script_workbench.demo.script.batch_name'),
        code: SCRIPT_STARTER_SOURCE,
        owner: 'local',
        visibility: 'private',
        folderId: folders[0].id,
        connections: [{ alias: 'prod', database: 'front_end_sys_dev' }],
        inputs: [{ alias: 'orders', name: t('script_workbench.demo.file_name'), sheetName: 'Sheet1', headerRow: 1 }],
        allowWrite: false,
        batchSize: 500,
        inListLimit: 1_000,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'script-demo-reconcile',
        name: t('script_workbench.demo.script.reconcile_name'),
        code: SCRIPT_STARTER_SOURCE,
        owner: 'local',
        visibility: 'shared',
        folderId: folders[1].id,
        connections: [],
        inputs: [],
        allowWrite: false,
        batchSize: 500,
        inListLimit: 1_000,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      },
    ];
  };

  const snapshot = () => ({
    success: true,
    data: {
      owner: 'local',
      scripts: clone(scripts),
      folders: clone(folders),
      canWrite: true,
      canShare: true,
      sharedOnly: false,
      canManageShared: true,
    },
  });

  const runSnapshot = (runId: string) => {
    const run = runs.get(runId);
    if (!run) return { success: false, message: 'script run not found' };
    const { rows: _rows, ...data } = clone(run);
    return { success: true, data };
  };

  const pushRun = (run: MockRun) => {
    const emit = (callback: () => void, delay: number) => {
      const timer = globalThis.setTimeout(callback, delay) as unknown as number;
      timers.set(run.runId, [...(timers.get(run.runId) || []), timer]);
    };
    emit(() => {
      run.status = 'running';
      run.stage = 'query';
      run.dbCalls = 32;
      run.progress = { current: 98_500, total: 812_430, message: t('script_workbench.demo.log.batch', { current: 32, total: 163 }) };
      run.logs.push({ timestamp: now(), level: 'info', message: t('script_workbench.demo.log.start') });
    }, 80);
    emit(() => {
      run.outputs = [{
        index: 0,
        name: 'matched_users',
        columns: ['id', 'status', 'tenant'],
        rowCount: 18_000,
      }];
      run.rows = Array.from({ length: 18_000 }, (_, index) => ({
        id: 1_048_000 + index,
        status: index % 7 === 0 ? 'pending' : 'active',
        tenant: `tenant_${(index % 4) + 1}`,
      }));
      run.progress = { current: 812_430, total: 812_430, message: t('script_workbench.demo.log.batch', { current: 163, total: 163 }) };
    }, 650);
    emit(() => {
      run.status = 'succeeded';
      run.stage = 'succeeded';
      run.finishedAt = now();
      run.progress = { current: 812_430, total: 812_430, message: t('script_workbench.demo.log.done') };
      run.logs.push({ timestamp: now(), level: 'info', message: t('script_workbench.demo.log.done') });
      timers.delete(run.runId);
    }, 1_350);
  };

  return {
    GetScriptLibrarySnapshot: async () => {
      initialize();
      return snapshot();
    },
    SelectScriptInputFile: async () => ({
      success: true,
      data: { path: 'C:/mock/orders_ids.xlsx', name: t('script_workbench.demo.file_name') },
    }),
    ListScriptInputSheets: async () => ({
      success: true,
      data: { sheets: ['Sheet1', 'Sheet2'] },
    }),
    SaveScriptLibraryScript: async (input: Partial<MockScript> & { revision?: number }) => {
      initialize();
      const index = scripts.findIndex((script) => script.id === input.id);
      if (index >= 0) {
        const current = scripts[index];
        if (Number(input.revision) !== current.revision) {
          return { success: false, message: 'script was modified by another session; reload and retry' };
        }
        scripts[index] = {
          ...current,
          ...clone(input),
          id: current.id,
          owner: current.owner,
          revision: current.revision + 1,
          updatedAt: now(),
        } as MockScript;
        return { success: true, data: clone(scripts[index]) };
      }
      const script: MockScript = {
        id: nextId('script'),
        name: String(input.name || ''),
        description: String(input.description || ''),
        code: String(input.code || ''),
        owner: 'local',
        visibility: input.visibility === 'shared' ? 'shared' : 'private',
        folderId: input.folderId,
        connections: clone(input.connections || []),
        inputs: clone(input.inputs || []),
        allowWrite: input.allowWrite === true,
        batchSize: Number(input.batchSize) || 500,
        inListLimit: Number(input.inListLimit) || 1_000,
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      scripts.unshift(script);
      return { success: true, data: clone(script) };
    },
    SaveScriptLibraryFolder: async (input: Partial<MockFolder> & { revision?: number }) => {
      initialize();
      const index = folders.findIndex((folder) => folder.id === input.id);
      if (index >= 0) {
        if (Number(input.revision) !== folders[index].revision) {
          return { success: false, message: 'folder was modified by another session; reload and retry' };
        }
        folders[index] = {
          ...folders[index],
          ...clone(input),
          id: folders[index].id,
          revision: folders[index].revision + 1,
          updatedAt: now(),
        } as MockFolder;
        return { success: true, data: clone(folders[index]) };
      }
      const folder: MockFolder = {
        id: nextId('folder'),
        name: String(input.name || ''),
        parentId: input.parentId,
        owner: 'local',
        visibility: input.visibility === 'shared' ? 'shared' : 'private',
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      folders.unshift(folder);
      return { success: true, data: clone(folder) };
    },
    DeleteScriptLibraryScript: async (input: { id?: string; revision?: number }) => {
      initialize();
      const index = scripts.findIndex((script) => script.id === input.id);
      if (index < 0) return { success: false, message: 'script not found' };
      if (Number(input.revision) !== scripts[index].revision) return { success: false, message: 'revision conflict' };
      scripts.splice(index, 1);
      return { success: true };
    },
    DeleteScriptLibraryFolder: async (input: { id?: string; revision?: number }) => {
      initialize();
      if (scripts.some((script) => script.folderId === input.id)) {
        return { success: false, message: 'folder is not empty' };
      }
      const index = folders.findIndex((folder) => folder.id === input.id);
      if (index < 0) return { success: false, message: 'folder not found' };
      if (Number(input.revision) !== folders[index].revision) return { success: false, message: 'revision conflict' };
      folders.splice(index, 1);
      return { success: true };
    },
    SetScriptLibraryScriptVisibility: async (input: { id?: string; revision?: number; visibility?: string }) => {
      initialize();
      const script = scripts.find((item) => item.id === input.id);
      if (!script) return { success: false, message: 'script not found' };
      if (Number(input.revision) !== script.revision) return { success: false, message: 'revision conflict' };
      script.visibility = input.visibility === 'shared' ? 'shared' : 'private';
      script.revision += 1;
      script.updatedAt = now();
      if (script.visibility === 'shared') {
        script.connections = script.connections.map((connection) => ({ ...connection, connectionId: '' }));
        script.inputs = script.inputs.map((binding) => ({ ...binding, path: '', reference: '' }));
      }
      return { success: true, data: clone(script) };
    },
    SetScriptLibraryFolderVisibility: async (input: { id?: string; revision?: number; visibility?: string }) => {
      initialize();
      const folder = folders.find((item) => item.id === input.id);
      if (!folder) return { success: false, message: 'folder not found' };
      if (Number(input.revision) !== folder.revision) return { success: false, message: 'revision conflict' };
      folder.visibility = input.visibility === 'shared' ? 'shared' : 'private';
      folder.revision += 1;
      folder.updatedAt = now();
      return { success: true, data: clone(folder) };
    },
    PrepareScriptWorkbenchWrite: async (request: { allowWrite?: boolean }) => {
      const required = request.allowWrite === true;
      return {
        success: true,
        data: {
          requiresConfirmation: required,
          confirmationToken: required ? nextId('script-write-token') : undefined,
        },
      };
    },
    RunScriptWorkbench: async (request: {
      scriptId?: string;
      title?: string;
      allowWrite?: boolean;
      confirmationToken?: string;
      writeApprovalToken?: string;
    }) => {
      if (request.allowWrite === true && !request.confirmationToken && !request.writeApprovalToken) {
        return { success: false, message: 'write confirmation requires a fresh approval token' };
      }
      const runId = nextId('script-run');
      const startedAt = now();
      const run: MockRun = {
        runId,
        scriptId: request.scriptId,
        title: request.title,
        status: 'queued',
        stage: 'queued',
        startedAt,
        maxDbCalls: 10_000,
        dbCalls: 0,
        logs: [],
        outputs: [],
        rows: [],
      };
      runs.set(runId, run);
      pushRun(run);
      return { success: true, data: { ...clone(run), rows: undefined } };
    },
    GetScriptWorkbenchRun: async (runId: string) => runSnapshot(runId),
    CancelScriptWorkbenchRun: async (runId: string) => {
      const run = runs.get(runId);
      if (!run) return { success: false, message: 'script run not found' };
      timers.get(runId)?.forEach((timer) => globalThis.clearTimeout(timer));
      timers.delete(runId);
      run.status = 'cancelled';
      run.stage = 'cancelled';
      run.cancelled = true;
      run.finishedAt = now();
      return runSnapshot(runId);
    },
    GetScriptWorkbenchOutput: async (runId: string, outputIndex: number, page: number, pageSize: number) => {
      const run = runs.get(runId);
      const output = run?.outputs[outputIndex];
      if (!run || !output) return { success: false, message: 'script output not found' };
      const safePage = Math.max(1, Math.floor(page) || 1);
      const safeSize = Math.max(1, Math.min(500, Math.floor(pageSize) || 100));
      const start = (safePage - 1) * safeSize;
      return {
        success: true,
        data: {
          outputIndex,
          name: output.name,
          columns: clone(output.columns),
          rows: clone(run.rows.slice(start, start + safeSize)),
          total: run.rows.length,
          page: safePage,
          pageSize: safeSize,
          truncated: output.truncated === true,
        },
      };
    },
  };
};
