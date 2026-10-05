import { t } from "../../i18n";
import { Checkbox, Form } from "antd";
import type { ConnectionStep2ProtectionApi } from "./connectionStep2Protection";
import type { ConnectionStep2StateApi } from "./useConnectionStep2State";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface ConnectionStep2ProtectionFieldsProps {
  showConnectionReadOnlyField: ConnectionStep2ProtectionApi['showConnectionReadOnlyField'];
  readOnlyProtectionExpanded: ConnectionStep2StateApi['readOnlyProtectionExpanded'];
  setReadOnlyProtectionExpanded: ConnectionStep2StateApi['setReadOnlyProtectionExpanded'];
  connectionProtectionEnabledCount: ConnectionStep2ProtectionApi['connectionProtectionEnabledCount'];
  allReadOnlyChecked: ConnectionStep2ProtectionApi['allReadOnlyChecked'];
  toggleAllReadOnlyProtection: ConnectionStep2ProtectionApi['toggleAllReadOnlyProtection'];
  restrictDataEdit: ConnectionStep2ProtectionApi['restrictDataEdit'];
  isNacosProtection: ConnectionStep2ProtectionApi['isNacosProtection'];
  restrictStructureEdit: ConnectionStep2ProtectionApi['restrictStructureEdit'];
  supportsScriptExecutionProtection: ConnectionStep2ProtectionApi['supportsScriptExecutionProtection'];
  restrictScriptExecution: ConnectionStep2ProtectionApi['restrictScriptExecution'];
  restrictDataImport: ConnectionStep2ProtectionApi['restrictDataImport'];
  setChoiceFieldValue: ConnectionModalStep2Props['setChoiceFieldValue'];
  clearConnectionTestResultForChoice: ConnectionModalStep2Props['clearConnectionTestResultForChoice'];
}

export const ConnectionStep2ProtectionFields = ({
  showConnectionReadOnlyField,
  readOnlyProtectionExpanded,
  setReadOnlyProtectionExpanded,
  connectionProtectionEnabledCount,
  allReadOnlyChecked,
  toggleAllReadOnlyProtection,
  restrictDataEdit,
  isNacosProtection,
  restrictStructureEdit,
  supportsScriptExecutionProtection,
  restrictScriptExecution,
  restrictDataImport,
  setChoiceFieldValue,
  clearConnectionTestResultForChoice,
}: ConnectionStep2ProtectionFieldsProps) => (
  <>
    {/* 生产连接保护 · Demo：紧挨模式下方；默认展开；扁平列表 */}
    {showConnectionReadOnlyField && (
      <div
        className="gn-conn-prot"
        data-open={readOnlyProtectionExpanded ? "1" : "0"}
        data-connection-config-section="readOnly"
      >
        <button
          type="button"
          className="gn-conn-prot-head"
          data-connection-config-section-toggle="readOnly"
          aria-expanded={readOnlyProtectionExpanded}
          onClick={() =>
            setReadOnlyProtectionExpanded((expanded) => !expanded)
          }
        >
          <span className="gn-conn-prot-chev" aria-hidden="true" />
          <span className="gn-conn-prot-title">
            {t("connection.modal.section.readOnly.title")}
          </span>
          <span
            className={`gn-conn-prot-tag${
              connectionProtectionEnabledCount > 0 ? " on" : ""
            }`}
          >
            {connectionProtectionEnabledCount > 0
              ? t(
                  "connection.modal.field.readOnly.status.enabledCount",
                  { count: connectionProtectionEnabledCount },
                )
              : t("connection.modal.field.readOnly.status.disabled")}
          </span>
        </button>
        {readOnlyProtectionExpanded ? (
          <div className="gn-conn-prot-body">
            <button
              type="button"
              className="gn-conn-prot-opt gn-conn-prot-opt-all"
              aria-pressed={allReadOnlyChecked}
              data-connection-config-section="readOnlyAll"
              onClick={toggleAllReadOnlyProtection}
            >
              <span
                onClick={(event) => event.stopPropagation()}
                style={{ justifySelf: "center", marginTop: 2 }}
              >
                <Checkbox
                  checked={allReadOnlyChecked}
                  onChange={toggleAllReadOnlyProtection}
                />
              </span>
              <div>
                <div className="n">
                  {t(
                    "connection.modal.field.readOnly.option.all.label",
                  )}
                </div>
                <div className="h">
                  {t(
                    "connection.modal.field.readOnly.option.all.help",
                  )}
                </div>
              </div>
            </button>
            {[
              {
                field: "restrictDataEdit",
                checked: restrictDataEdit,
                label: t(
                  "connection.modal.field.readOnly.option.dataEdit.label",
                ),
                help: t(
                  isNacosProtection
                    ? "connection.modal.field.readOnly.option.nacos.dataEdit.help"
                    : "connection.modal.field.readOnly.option.dataEdit.help",
                ),
              },
              {
                field: "restrictStructureEdit",
                checked: restrictStructureEdit,
                label: t(
                  "connection.modal.field.readOnly.option.structureEdit.label",
                ),
                help: t(
                  isNacosProtection
                    ? "connection.modal.field.readOnly.option.nacos.structureEdit.help"
                    : "connection.modal.field.readOnly.option.structureEdit.help",
                ),
              },
              ...(supportsScriptExecutionProtection
                ? [
                    {
                      field: "restrictScriptExecution",
                      checked: restrictScriptExecution,
                      label: t(
                        "connection.modal.field.readOnly.option.scriptExecution.label",
                      ),
                      help: t(
                        "connection.modal.field.readOnly.option.scriptExecution.help",
                      ),
                    },
                  ]
                : []),
              {
                field: "restrictDataImport",
                checked: restrictDataImport,
                label: t(
                  "connection.modal.field.readOnly.option.dataImport.label",
                ),
                help: t(
                  isNacosProtection
                    ? "connection.modal.field.readOnly.option.nacos.dataImport.help"
                    : "connection.modal.field.readOnly.option.dataImport.help",
                ),
              },
            ].map((item) => (
              <button
                key={item.field}
                type="button"
                className="gn-conn-prot-opt"
                onClick={() =>
                  setChoiceFieldValue(item.field, !item.checked)
                }
              >
                <span
                  onClick={(event) => event.stopPropagation()}
                  style={{ justifySelf: "center", marginTop: 2 }}
                >
                  <Form.Item
                    name={item.field}
                    valuePropName="checked"
                    noStyle
                  >
                    <Checkbox
                      onChange={() =>
                        clearConnectionTestResultForChoice()
                      }
                    />
                  </Form.Item>
                </span>
                <div>
                  <div className="n">{item.label}</div>
                  <div className="h">{item.help}</div>
                </div>
              </button>
            ))}
            <div className="gn-conn-prot-sum">
              {t("connection.modal.field.readOnly.summary.title")}
              {": "}
              {connectionProtectionEnabledCount > 0
                ? t(
                    "connection.modal.field.readOnly.summary.selected",
                    { count: connectionProtectionEnabledCount },
                  )
                : t("connection.modal.field.readOnly.status.disabled")}
            </div>
          </div>
        ) : null}
      </div>
    )}
  </>
);
