import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

// Names documented in docs/plugins/sdk.md. Removing or renaming one is a breaking change for
// third-party plugins. The authoritative guide is maintained by GoNavi-Plugin-Market;
// this checkout validates it when the sibling repository is available.
const DOCUMENTED: Record<string, 'function' | 'number'> = {
  DEFAULT_MAX_FRAME_BYTES: 'number',
  AI_PROVIDER_IMAGE_MAX_REQUEST_BYTES: 'number',
  DATA_SOURCE_PROTOCOL_VERSION: 'number',
  DATA_SOURCE_WRITE_PROTOCOL_VERSION: 'number',
  FrameReader: 'function',
  Protocol: 'function',
  ProtocolError: 'function',
  DataSourceDispatcher: 'function',
  validateCommand: 'function',
  validatePermissionNotes: 'function',
  validateSkillMetadata: 'function',
  validateSkillResources: 'function',
  validateSkillDocument: 'function',
  validateDataSource: 'function',
  validateDataSourceCommand: 'function',
  validateAIProvider: 'function',
  validateExporter: 'function',
  validatePages: 'function',
  parseManifest: 'function',
};

describe('documented SDK exports', () => {
  it.skipIf(!existsSync(new URL('../../../../GoNavi-Plugin-Market/docs/plugins/sdk.md', import.meta.url)))(
    'keeps every documented runtime export and mentions it in the guide',
    () => {
    const guide = readFileSync(
      new URL('../../../../GoNavi-Plugin-Market/docs/plugins/sdk.md', import.meta.url),
      'utf8',
    );
    for (const [name, kind] of Object.entries(DOCUMENTED)) {
      expect(typeof (sdk as Record<string, unknown>)[name], name).toBe(kind);
      expect(guide.includes(name), `${name} is missing from docs/plugins/sdk.md`).toBe(true);
    }
    },
  );
});
