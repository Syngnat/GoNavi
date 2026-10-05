import { t } from "../../i18n";
import { Form, Input, Space, Button, Alert } from "antd";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { getUriPlaceholder } from "./connectionModalUri";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface CreateConnectionStep2UriBlockInput {
  isCustom: ConnectionModalStep2Props['isCustom'];
  isJVM: ConnectionModalStep2Props['isJVM'];
  dbType: ConnectionModalStep2Props['dbType'];
  uriFeedback: ConnectionModalStep2Props['uriFeedback'];
  handleParseURI: ConnectionModalStep2Props['handleParseURI'];
  handleGenerateURI: ConnectionModalStep2Props['handleGenerateURI'];
  handleCopyURI: ConnectionModalStep2Props['handleCopyURI'];
  resolvedUriFeedbackMessage: ConnectionModalStep2Props['resolvedUriFeedbackMessage'];
  setUriFeedback: ConnectionModalStep2Props['setUriFeedback'];
  renderStoredSecretControls: ConnectionModalStep2Props['renderStoredSecretControls'];
  initialValues: ConnectionModalStep2Props['initialValues'];
}

export const createConnectionStep2UriBlock = ({
  isCustom,
  isJVM,
  dbType,
  uriFeedback,
  handleParseURI,
  handleGenerateURI,
  handleCopyURI,
  resolvedUriFeedbackMessage,
  setUriFeedback,
  renderStoredSecretControls,
  initialValues,
}: CreateConnectionStep2UriBlockInput) => {
  const uriQuickBlock =
    !isCustom && !isJVM ? (
      <div className="gn-conn-uri-block">
        <div className="gn-conn-uri-block-top">
          <div>
            <span className="ttl">{t("connection.modal.config_section.uri.title")}</span>
            <span className="hint">{t("connection.modal.uri.optionalHint")}</span>
          </div>
        </div>
        <Form.Item name="uri" noStyle>
          <Input.TextArea
            {...noAutoCapInputProps}
            rows={2}
            placeholder={getUriPlaceholder(dbType)}
          />
        </Form.Item>
        <Space
          size={8}
          className="gn-conn-uri-actions"
          style={{ marginBottom: uriFeedback ? 8 : 0 }}
          wrap
        >
          <Button size="small" onClick={handleParseURI}>
            {t("connection.modal.uri.action.parse")}
          </Button>
          <Button size="small" onClick={handleGenerateURI}>
            {t("connection.modal.uri.action.generate")}
          </Button>
          <Button size="small" onClick={handleCopyURI}>
            {t("connection.modal.uri.action.copy")}
          </Button>
        </Space>
        {uriFeedback && (
          <Alert
            showIcon
            closable
            type={uriFeedback.type}
            message={resolvedUriFeedbackMessage}
            onClose={() => setUriFeedback(null)}
            style={{ marginTop: 8, marginBottom: 0 }}
          />
        )}
        {renderStoredSecretControls({
          fieldName: "uri",
          clearKey: "opaqueURI",
          hasStoredSecret: initialValues?.hasOpaqueURI,
          clearLabel: t("connection.modal.uri.stored.clear"),
          description: t("connection.modal.uri.stored.description"),
        })}
      </div>
    ) : null;

  /** Demo 短标签；完整文案放 title，避免窄列换行 */
  const denseLabel = (shortText: string, fullTitle?: string) => (
    <span className="gn-conn-f-label" title={fullTitle || shortText}>
      {shortText}
    </span>
  );
  return { uriQuickBlock, denseLabel };
};

export type ConnectionStep2UriBlockApi = ReturnType<typeof createConnectionStep2UriBlock>;
