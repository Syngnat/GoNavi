import { summarizeConnectionTestFailureMessage } from "../../utils/connectionModalPresentation";
import { t } from "../../i18n";
import { Button, Space } from "antd";
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  FileTextOutlined,
  SafetyCertificateOutlined,
  PlusOutlined,
  RightOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { getDbDefaultColor, getDbIcon } from "../DatabaseIcons";
import React from "react";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalTypeCatalogApi } from "./useConnectionModalTypeCatalog";
import type { ConnectionModalSaveAndTestApi } from "./useConnectionModalSaveAndTest";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalChromeInput {
  initialValues: ConnectionModalProps['initialValues'];
  onOpenConnectionHealth: ConnectionModalProps['onOpenConnectionHealth'];
  step: ConnectionModalStateApi['step'];
  setStep: ConnectionModalStateApi['setStep'];
  dbTypes: ConnectionModalTypeCatalogApi['dbTypes'];
  dbType: ConnectionModalStateApi['dbType'];
  testResult: ConnectionModalStateApi['testResult'];
  resolvedTestResultMessage: ConnectionModalStateApi['resolvedTestResultMessage'];
  currentDriverUnavailableReason: ConnectionModalTypeCatalogApi['currentDriverUnavailableReason'];
  driverStatusChecking: ConnectionModalTypeCatalogApi['driverStatusChecking'];
  unsupportedJvmModeMessage: ConnectionModalTypeCatalogApi['unsupportedJvmModeMessage'];
  setTestErrorLogOpen: ConnectionModalStateApi['setTestErrorLogOpen'];
  saving: ConnectionModalStateApi['saving'];
  testingConnection: ConnectionModalStateApi['testingConnection'];
  requestTest: ConnectionModalSaveAndTestApi['requestTest'];
  cancelActiveConnectionTest: ConnectionModalLifecycleApi['cancelActiveConnectionTest'];
  handleModalClose: ConnectionModalLifecycleApi['handleModalClose'];
  handleOk: ConnectionModalSaveAndTestApi['handleOk'];
}

export const useConnectionModalChrome = ({
  initialValues,
  onOpenConnectionHealth,
  step,
  setStep,
  dbTypes,
  dbType,
  testResult,
  resolvedTestResultMessage,
  currentDriverUnavailableReason,
  driverStatusChecking,
  unsupportedJvmModeMessage,
  setTestErrorLogOpen,
  saving,
  testingConnection,
  requestTest,
  cancelActiveConnectionTest,
  handleModalClose,
  handleOk,
}: UseConnectionModalChromeInput) => {
  const getFooter = () => {
    if (step === 1) {
      return null;
    }
    const typeName = dbTypes.find((t) => t.key === dbType)?.name || dbType;
    const isTestSuccess = testResult?.type === "success";
    const hasTestError = !!testResult && !isTestSuccess;
    const testFailureSummary = hasTestError
      ? summarizeConnectionTestFailureMessage(
          resolvedTestResultMessage,
          t("connection.status.failure"),
        )
      : "";
    const operationBlocked =
      !!currentDriverUnavailableReason ||
      driverStatusChecking ||
      !!unsupportedJvmModeMessage;
    return (
      <div className="gn-conn-studio-foot">
        <div className="gn-conn-studio-foot-left">
          {!initialValues && (
            <Button
              key="back"
              className="gn-conn-studio-button"
              icon={<ArrowLeftOutlined />}
              onClick={() => setStep(1)}
            >
              {t("common.action.back")}
            </Button>
          )}
          <span
            className="gn-conn-studio-foot-status"
            data-status={testResult ? (isTestSuccess ? "success" : "error") : "idle"}
          >
            {testResult ? (
              <>
              {isTestSuccess ? <CheckCircleFilled /> : <CloseCircleFilled />}
                <span>
                  {isTestSuccess
                    ? t("connection.status.success")
                    : t("connection.status.failure")}
                </span>
              </>
            ) : (
              `${t("connection.modal.studio.test.idle")} · ${typeName}`
            )}
          </span>
          {hasTestError && (
            <span
              data-connection-test-error-summary="true"
              title={testFailureSummary}
              className="gn-conn-studio-foot-error"
            >
              {testFailureSummary}
            </span>
          )}
          {hasTestError && (
            <Button
              size="small"
              icon={<FileTextOutlined />}
              className="gn-conn-studio-details-button"
              onClick={() => setTestErrorLogOpen(true)}
            >
              {t("connection.action.viewDetails")}
            </Button>
          )}
        </div>
        <Space size={8} className="gn-conn-studio-foot-right">
          {initialValues?.id && onOpenConnectionHealth && (
            <Button
              key="connection-health"
              className="gn-conn-studio-button"
              icon={<SafetyCertificateOutlined />}
              disabled={saving || testingConnection}
              onClick={() => onOpenConnectionHealth(initialValues)}
            >
              {t("connection_health.action.open")}
            </Button>
          )}
          <Button
            key="test"
            className="gn-conn-studio-button"
            loading={testingConnection}
            disabled={operationBlocked || saving}
            onClick={requestTest}
          >
            {t("connection.action.test")}
          </Button>
          {testingConnection ? (
            <Button
              key="cancel-test"
              danger
              className="gn-conn-studio-button"
              onClick={cancelActiveConnectionTest}
            >
              {t("connection.modal.action.cancel_test")}
            </Button>
          ) : null}
          <Button
            key="cancel"
            className="gn-conn-studio-button"
            onClick={handleModalClose}
          >
            {t("common.action.cancel")}
          </Button>
          <Button
            key="submit"
            type="primary"
            className="gn-conn-studio-button"
            loading={saving}
            disabled={operationBlocked || testingConnection}
            onClick={handleOk}
          >
            {t("common.action.save")}
          </Button>
        </Space>
      </div>
    );
  };

  const getStudioTitle = () => {
    const typeName = dbTypes.find((t) => t.key === dbType)?.name || dbType;
    // 是否处于第一步数据源选型页。
    const pickerStep = step === 1;
    // Studio 标题栏三段进度文案。
    const stepItems = pickerStep
      ? [
          t("connection.modal.studio.step.chooseType"),
          t("connection.modal.studio.step.configure"),
          t("connection.modal.studio.step.testSave"),
        ]
      : [
          t("connection.modal.studio.step.type"),
          t("connection.modal.studio.step.params"),
          t("connection.modal.studio.step.save"),
        ];
    // 当前步骤对应的标题文案。
    const title = pickerStep
      ? t("connection.modal.title.step1")
      : initialValues
        ? t("connection.modal.studio.title.edit", { type: typeName })
        : t("connection.modal.studio.title.connection", { type: typeName });
    return (
      <div className="gn-conn-studio-header" data-connection-step={step}>
        <div className="gn-conn-studio-header-left">
          <div
            className="gn-conn-studio-type-badge"
            style={pickerStep ? undefined : { background: getDbDefaultColor(dbType) }}
            aria-hidden="true"
          >
            {pickerStep ? <PlusOutlined /> : getDbIcon(dbType, "#ffffff", 28)}
          </div>
          <div className="gn-conn-studio-heading">
            <div className="gn-conn-studio-title">{title}</div>
            {pickerStep ? (
              <div className="gn-conn-studio-subtitle">
                {t("connection.modal.description.step1")}
              </div>
            ) : null}
          </div>
        </div>
        <div className="gn-conn-studio-steps" aria-label={t("connection.modal.studio.progress")}>
          {stepItems.map((item, index) => {
            // 当前高亮的进度节点。
            const active = pickerStep ? index === 0 : index === 1;
            // 已完成的进度节点。
            const done = !pickerStep && index === 0;
            return (
              <React.Fragment key={item}>
                {index > 0 ? (
                  <RightOutlined className="gn-conn-studio-step-arrow" aria-hidden="true" />
                ) : null}
                <span data-active={active ? "true" : undefined} data-done={done ? "true" : undefined}>
                  {index + 1} {item}
                </span>
              </React.Fragment>
            );
          })}
        </div>
        <button
          type="button"
          className="gn-conn-studio-close"
          aria-label={t("common.action.close")}
          title={t("common.action.close")}
          onClick={handleModalClose}
        >
          <CloseOutlined />
        </button>
      </div>
    );
  };
  return { getFooter, getStudioTitle };
};

export type ConnectionModalChromeApi = ReturnType<typeof useConnectionModalChrome>;
