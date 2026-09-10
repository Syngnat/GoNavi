import { describe, expect, it, vi } from 'vitest';

import { installMonacoWorkerEnvironment } from './MonacoEditor';

describe('MonacoEditor worker environment', () => {
  it('routes Monaco languages to bundled workers', () => {
    const createWorker = (name: string) => vi.fn(() => ({ name } as unknown as Worker));
    const workers = {
      editor: createWorker('editor'),
      json: createWorker('json'),
    };
    const scope: Record<string, any> = {};

    installMonacoWorkerEnvironment(scope, workers);

    expect(scope.MonacoEnvironment.getWorker('', 'json')).toEqual({ name: 'json' });
    expect(scope.MonacoEnvironment.getWorker('', 'sql')).toEqual({ name: 'editor' });
    expect(scope.MonacoEnvironment.getWorker('', 'yaml')).toEqual({ name: 'editor' });
  });

  it('falls unused language workers (css/html/typescript) back to the base worker', () => {
    const createWorker = (name: string) => vi.fn(() => ({ name } as unknown as Worker));
    const workers = {
      editor: createWorker('editor'),
      json: createWorker('json'),
    };
    const scope: Record<string, any> = {};

    installMonacoWorkerEnvironment(scope, workers);

    expect(scope.MonacoEnvironment.getWorker('', 'css')).toEqual({ name: 'editor' });
    expect(scope.MonacoEnvironment.getWorker('', 'scss')).toEqual({ name: 'editor' });
    expect(scope.MonacoEnvironment.getWorker('', 'html')).toEqual({ name: 'editor' });
    expect(scope.MonacoEnvironment.getWorker('', 'handlebars')).toEqual({ name: 'editor' });
    expect(scope.MonacoEnvironment.getWorker('', 'typescript')).toEqual({ name: 'editor' });
    expect(scope.MonacoEnvironment.getWorker('', 'javascript')).toEqual({ name: 'editor' });
  });
});
