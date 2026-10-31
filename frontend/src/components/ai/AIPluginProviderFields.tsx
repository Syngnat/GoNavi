import { Button, Form, Input } from 'antd';
import type { PluginAIModel } from '../../plugins/aiProvider/types';
import type { AccountKeyItem } from './aiPluginProviderAccountApi';
import AIPluginProviderKeyPicker from './AIPluginProviderKeyPicker';
import { modelCatalogWindowFor, type ModelCatalogEntry } from '../../utils/modelsDevCatalog';

type CopyText = (key: string, params?: Record<string, string | number>) => string;

interface AIPluginProviderFieldsProps {
  t: CopyText;
  model?: PluginAIModel;
  hasSavedKey: boolean;
  savedKeyHint: string;
  replacingKey: boolean;
  onReplaceKey: () => void;
  onPickedKey?: () => void;
  keyChoices?: AccountKeyItem[];
  /** models.dev 公共目录索引：网关别名在这里可能写着比清单更大的窗口。 */
  catalog?: Map<string, ModelCatalogEntry>;
}

export default function AIPluginProviderFields({
  t, model, hasSavedKey, savedKeyHint, replacingKey, onReplaceKey, onPickedKey, keyChoices, catalog,
}: AIPluginProviderFieldsProps) {
  const showSavedKey = hasSavedKey && !replacingKey;
  const choices = (keyChoices ?? []).filter((item) => item.key);
  // 与芯片徽标同一口径：目录认得就用目录窗口，否则用插件声明的那个。
  const contextWindow = model ? modelCatalogWindowFor(catalog, model.id) || model.contextWindow : 0;
  return (
    <div className="gn-field-grid">
      <div className="gn-field is-wide">
        <Form.Item name="name" label={t('plugin.ai_provider.name')}>
          <Input maxLength={256} />
        </Form.Item>
      </div>

      <div className="gn-field">
        <Form.Item name="baseUrl" label={t('plugin.ai_provider.base_url_short')} extra={t('plugin.ai_provider.base_url_hint')}>
          <Input autoComplete="off" maxLength={4096} />
        </Form.Item>
      </div>

      <div className="gn-field">
        <Form.Item name="apiKey" label={t('plugin.ai_provider.api_key')}>
          {showSavedKey ? (
            <div className="gn-key-saved">
              <span className="gn-key-saved-dot" aria-hidden="true" />
              <span className="gn-key-saved-text">{t('plugin.ai_provider.api_key_saved', { hint: savedKeyHint ? ' ····' + savedKeyHint : '' })}</span>
              <Button type="link" size="small" className="gn-key-replace" onClick={onReplaceKey}>
                {t('plugin.ai_provider.api_key_replace')}
              </Button>
            </div>
          ) : (
            <AIPluginProviderKeyPicker
              choices={choices}
              autoOpen={replacingKey}
              onPicked={() => onPickedKey?.()}
            />
          )}
        </Form.Item>
      </div>

      {model && (
        <p className="gn-field-note is-wide">
          {t('plugin.ai_provider.model_limits', { context: contextWindow, output: model.maxOutputTokens })}
        </p>
      )}
    </div>
  );
}
