export const isTestRuntime = (): boolean => {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env || {};
  return env.MODE === 'test' || env.VITEST === true || env.VITEST === 'true';
};

type MonacoWorkerFactory = () => Worker;

interface MonacoWorkerFactories {
  editor: MonacoWorkerFactory;
  json: MonacoWorkerFactory;
}

export const installMonacoWorkerEnvironment = (
  scope: Record<string, any>,
  workers: MonacoWorkerFactories,
) => {
  scope.MonacoEnvironment = {
    ...(scope.MonacoEnvironment || {}),
    getWorker(_moduleId: string, label: string) {
      if (label === 'json') return workers.json();
      // css/html/typescript workers are intentionally not bundled: no editor
      // instance uses those languages, so they fall back to the base worker.
      return workers.editor();
    },
  };
};
