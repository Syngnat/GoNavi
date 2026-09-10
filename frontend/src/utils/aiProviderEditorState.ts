import type { AIProviderAuthMode, AIProviderConfig, AIProviderType } from '../types';
import { rowsFromRecord } from './aiProviderKeyValue';

type ProviderEditorStatus = 'idle' | 'success' | 'error';

type ProviderEditorConfig = Partial<AIProviderConfig> & Pick<AIProviderConfig, 'id' | 'type' | 'name' | 'apiKey'> & { presetKey?: string };

export interface ProviderEditorSession {
  editingProvider: ProviderEditorConfig | null;
  formValues: Record<string, unknown> | null;
  isEditing: boolean;
  testStatus: ProviderEditorStatus;
}

interface BuildAddProviderEditorSessionInput {
  presetKey?: string;
  presetBackendType: AIProviderType;
  presetBaseUrl: string;
  presetModel: string;
  apiFormat?: string;
  authMode?: AIProviderAuthMode;
  connectionMode?: string;
}

interface BuildEditProviderEditorSessionInput {
  provider: ProviderEditorConfig;
  formValues?: Record<string, unknown>;
}

export const buildAddProviderEditorSession = ({
  presetKey = 'openai',
  presetBackendType,
  presetBaseUrl,
  presetModel,
  apiFormat = 'openai',
  authMode = 'api-key',
  connectionMode = '',
}: BuildAddProviderEditorSessionInput): ProviderEditorSession => {
  const editingProvider: ProviderEditorConfig = {
    id: '',
    type: presetBackendType,
    name: '',
    apiKey: '',
    authMode,
    baseUrl: presetBaseUrl,
    model: presetModel,
    temperature: 0.7,
    presetKey,
  };

  return {
    editingProvider,
    formValues: {
      ...editingProvider,
      presetKey,
      apiFormat,
      authMode,
      connectionMode,
      headerRows: [],
      cliEnvRows: [],
      cliPath: '',
    },
    isEditing: true,
    testStatus: 'idle',
  };
};

export const buildEditProviderEditorSession = ({
  provider,
  formValues,
}: BuildEditProviderEditorSessionInput): ProviderEditorSession => ({
  editingProvider: provider,
  formValues: formValues || {
    ...provider,
    presetKey: provider.presetKey,
    apiFormat: provider.apiFormat || 'openai',
    headerRows: rowsFromRecord(provider.headers),
    cliEnvRows: rowsFromRecord(provider.cliEnv),
    cliPath: provider.cliPath || '',
  },
  isEditing: true,
  testStatus: 'idle',
});

export const buildClosedProviderEditorSession = (): ProviderEditorSession => ({
  editingProvider: null,
  formValues: null,
  isEditing: false,
  testStatus: 'idle',
});
