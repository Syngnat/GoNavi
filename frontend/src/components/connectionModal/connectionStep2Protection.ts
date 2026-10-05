import { supportsConnectionReadOnlyMode } from "../../utils/connectionReadOnly";
import { Form } from "antd";
import {
  type ReadOnlyProtectionState,
  allReadOnlyProtectionChecked,
  toggleAllReadOnlyProtection as toggleAllReadOnlyProtectionState,
  readOnlyProtectionFields,
} from "./connectionModalReadOnly";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface CreateConnectionStep2ProtectionInput {
  dbType: ConnectionModalStep2Props['dbType'];
  form: ConnectionModalStep2Props['form'];
  oceanBaseProtocol: ConnectionModalStep2Props['oceanBaseProtocol'];
  setChoiceFieldValue: ConnectionModalStep2Props['setChoiceFieldValue'];
}

export const createConnectionStep2Protection = ({ dbType, form, oceanBaseProtocol, setChoiceFieldValue }: CreateConnectionStep2ProtectionInput) => {
  const showConnectionReadOnlyField = supportsConnectionReadOnlyMode({
    type: dbType,
    driver: form.getFieldValue("driver"),
    oceanBaseProtocol,
  });
  const restrictDataEdit = Form.useWatch("restrictDataEdit", form) === true;
  const restrictStructureEdit =
    Form.useWatch("restrictStructureEdit", form) === true;
  const restrictScriptExecution =
    Form.useWatch("restrictScriptExecution", form) === true;
  const restrictDataImport =
    Form.useWatch("restrictDataImport", form) === true;
  const isNacosProtection =
    String(dbType || "").trim().toLowerCase() === "nacos";
  const supportsScriptExecutionProtection = !isNacosProtection;
  const connectionProtectionEnabledCount = [
    restrictDataEdit,
    restrictStructureEdit,
    supportsScriptExecutionProtection && restrictScriptExecution,
    restrictDataImport,
  ].filter(Boolean).length;
  // 「仅只读」总开关（#1325）：派生逻辑与切换规则见 connectionModalReadOnly。
  const readOnlyProtectionState: ReadOnlyProtectionState = {
    restrictDataEdit,
    restrictStructureEdit,
    restrictScriptExecution,
    restrictDataImport,
  };
  const allReadOnlyChecked = allReadOnlyProtectionChecked(
    readOnlyProtectionState,
    supportsScriptExecutionProtection,
  );
  const toggleAllReadOnlyProtection = () => {
    const next = toggleAllReadOnlyProtectionState(
      readOnlyProtectionState,
      supportsScriptExecutionProtection,
    );
    for (const field of readOnlyProtectionFields(supportsScriptExecutionProtection)) {
      setChoiceFieldValue(field, next[field]);
    }
  };
  return {
    showConnectionReadOnlyField,
    restrictDataEdit,
    restrictStructureEdit,
    restrictScriptExecution,
    restrictDataImport,
    isNacosProtection,
    supportsScriptExecutionProtection,
    connectionProtectionEnabledCount,
    allReadOnlyChecked,
    toggleAllReadOnlyProtection,
  };
};

export type ConnectionStep2ProtectionApi = ReturnType<typeof createConnectionStep2Protection>;
