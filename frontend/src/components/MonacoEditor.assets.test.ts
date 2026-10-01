import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config';

describe('Monaco worktree font access', () => {
  it('allows codicon assets from the actual dependency directory without disabling file restrictions', () => {
    const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const dependencyRoot = realpathSync(path.resolve(frontendRoot, 'node_modules'));
    const allowed = (viteConfig.server?.fs?.allow ?? []).map((allowedPath) => path.resolve(allowedPath));
    expect(allowed).toContain(dependencyRoot);
    expect(viteConfig.server?.fs?.strict).not.toBe(false);
    expect(allowed).not.toContain(path.dirname(frontendRoot));
  });
});
