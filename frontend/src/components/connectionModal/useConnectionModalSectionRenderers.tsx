import type { ConnectionSecretKey } from "./connectionModalConfig";
import { Form, Checkbox, Space, Button } from "antd";
import { resolveInitialSecretFieldValue } from "./connectionModalHelpers";
import { t } from "../../i18n";
import React from "react";
import {
  type ConnectionConfigSectionKey,
  getConnectionConfigSectionCopy,
} from "../../utils/connectionModalPresentation";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalSectionRenderersInput {
  initialValues: ConnectionModalProps['initialValues'];
  revealedPrimaryPasswordRef: ConnectionModalStateApi['revealedPrimaryPasswordRef'];
  darkMode: ConnectionModalStateApi['darkMode'];
  clearSecrets: ConnectionModalStateApi['clearSecrets'];
  setClearSecrets: ConnectionModalStateApi['setClearSecrets'];
  overlayTheme: ConnectionModalStateApi['overlayTheme'];
  form: ConnectionModalStateApi['form'];
  clearSecretsRef: ConnectionModalStateApi['clearSecretsRef'];
  modalInnerSectionStyle: ConnectionModalLifecycleApi['modalInnerSectionStyle'];
  modalMutedTextStyle: ConnectionModalLifecycleApi['modalMutedTextStyle'];
}

export const useConnectionModalSectionRenderers = ({
  initialValues,
  revealedPrimaryPasswordRef,
  darkMode,
  clearSecrets,
  setClearSecrets,
  overlayTheme,
  form,
  clearSecretsRef,
  modalInnerSectionStyle,
  modalMutedTextStyle,
}: UseConnectionModalSectionRenderersInput) => {
  const renderStoredSecretControls = ({
    fieldName,
    clearKey,
    hasStoredSecret,
    clearLabel,
    description,
  }: {
    fieldName: string;
    clearKey: ConnectionSecretKey;
    hasStoredSecret?: boolean;
    clearLabel: string;
    description: string;
  }) => {
    if (!initialValues || !hasStoredSecret) {
      return null;
    }
    return (
      <Form.Item
        noStyle
        shouldUpdate={(prev, next) => prev[fieldName] !== next[fieldName]}
      >
        {({ getFieldValue }) => {
          const draftValue = getFieldValue(fieldName);
          const initialSecretValue =
            clearKey === "primaryPassword" &&
            revealedPrimaryPasswordRef.current !== ""
              ? revealedPrimaryPasswordRef.current
              : resolveInitialSecretFieldValue(initialValues, fieldName);
          const normalizedDraftValue = String(draftValue ?? "");
          const matchesInitialSecret =
            initialSecretValue !== "" &&
            normalizedDraftValue === initialSecretValue;
          const hasDraftValue =
            normalizedDraftValue !== "" && !matchesInitialSecret;
          const cardBorder = darkMode
            ? "1px solid rgba(255,255,255,0.12)"
            : "1px solid rgba(16,24,40,0.08)";
          const cardBg = darkMode
            ? "rgba(255,255,255,0.03)"
            : "rgba(16,24,40,0.03)";
          const effectiveChecked = clearSecrets[clearKey] && !hasDraftValue;
          return (
            <div
              style={{
                marginBottom: 16,
                padding: "10px 12px",
                borderRadius: 10,
                border: cardBorder,
                background: cardBg,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: overlayTheme.mutedText,
                  lineHeight: 1.6,
                  marginBottom: 8,
                }}
              >
                {hasDraftValue
                  ? t("connection.modal.secret.draftReplacement")
                  : description}
              </div>
              <Checkbox
                checked={effectiveChecked}
                disabled={hasDraftValue}
                onChange={(event) => {
                  const checked = event.target.checked;
                  if (checked && matchesInitialSecret) {
                    form.setFieldValue(fieldName, "");
                  }
                  const nextClearSecrets = {
                    ...clearSecretsRef.current,
                    [clearKey]: checked,
                  };
                  clearSecretsRef.current = nextClearSecrets;
                  setClearSecrets(nextClearSecrets);
                }}
              >
                {clearLabel}
              </Checkbox>
            </div>
          );
        }}
      </Form.Item>
    );
  };
  const renderConnectionModalTitle = (
    icon: React.ReactNode,
    title: string,
    description: string,
  ) => (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          display: "grid",
          placeItems: "center",
          background: overlayTheme.iconBg,
          color: overlayTheme.iconColor,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: overlayTheme.titleText,
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: 4,
            color: overlayTheme.mutedText,
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {description}
        </div>
      </div>
    </div>
  );

  const getConnectionOptionCardStyle = (
    _enabled: boolean,
  ): React.CSSProperties => ({
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid transparent",
    background: darkMode ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.72)",
    boxShadow: darkMode
      ? "inset 0 0 0 1px rgba(255,255,255,0.028)"
      : "inset 0 0 0 1px rgba(16,24,40,0.03)",
    transition: "all 120ms ease",
  });

  const jvmSectionCardStyle = (): React.CSSProperties => ({
    ...modalInnerSectionStyle,
    padding: 16,
  });

  const renderJvmSectionHeader = (
    icon: React.ReactNode,
    title: string,
    description: string,
    badge?: React.ReactNode,
    options?: {
      cursor?: React.CSSProperties["cursor"];
      marginBottom?: number;
      onClick?: () => void;
    },
  ) => (
    <div
      onClick={options?.onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: options?.marginBottom ?? 14,
        cursor: options?.cursor,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 12,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            background: darkMode
              ? "rgba(255,214,102,0.14)"
              : "rgba(22,119,255,0.10)",
            color: darkMode ? "#ffd666" : "#1677ff",
          }}
        >
          {icon}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: darkMode ? "#f5f7ff" : "#162033",
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            {title}
          </div>
          <div style={{ ...modalMutedTextStyle, marginTop: 4 }}>
            {description}
          </div>
        </div>
      </div>
      {badge ? <div style={{ flexShrink: 0 }}>{badge}</div> : null}
    </div>
  );

  // 表单分组改用「小标题 + 细分割线」而不是卡片：
  // 原先每个分组都是 16px 圆角 + 边框 + 内阴影 + 独立底色的卡片，一屏里叠七八个，
  // 视觉噪声极高且每张卡各占 16px 内边距，把真正的字段挤得很散。
  // 去掉边框/圆角/底色/内阴影，只保留组间的一条上分割线来划分层次，字段密度明显提升。
  const configSectionCardStyle = (): React.CSSProperties => ({
    paddingTop: 18,
    borderTop: darkMode
      ? "1px solid rgba(255,255,255,0.07)"
      : "1px solid rgba(16,24,40,0.07)",
  });

  const renderConfigSectionCard = ({
    sectionKey,
    icon,
    children,
    badge,
    collapsible,
    expanded = true,
    onToggle,
  }: {
    sectionKey: ConnectionConfigSectionKey;
    icon: React.ReactNode;
    children: React.ReactNode;
    badge?: React.ReactNode;
    collapsible?: boolean;
    expanded?: boolean;
    onToggle?: () => void;
  }) => {
    const copy = getConnectionConfigSectionCopy(sectionKey);
    const showChildren = !collapsible || expanded;
    const resolvedBadge = collapsible ? (
      <Space size={8}>
        {badge}
        <Button
          type="text"
          size="small"
          aria-label={copy.title}
          aria-expanded={expanded}
          data-connection-config-section-toggle={sectionKey}
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
          style={{
            width: 26,
            height: 26,
            minWidth: 26,
            padding: 0,
            borderRadius: 8,
            color: overlayTheme.mutedText,
          }}
        >
          {expanded ? <DownOutlined /> : <RightOutlined />}
        </Button>
      </Space>
    ) : badge;
    return (
      <div
        data-connection-config-section={sectionKey}
        style={configSectionCardStyle()}
      >
        {renderJvmSectionHeader(
          icon,
          copy.title,
          copy.description,
          resolvedBadge,
          collapsible
            ? {
                cursor: "pointer",
                marginBottom: showChildren ? 14 : 0,
                onClick: onToggle,
              }
            : undefined,
        )}
        {showChildren ? children : null}
      </div>
    );
  };
  return {
    renderStoredSecretControls,
    renderConnectionModalTitle,
    getConnectionOptionCardStyle,
    jvmSectionCardStyle,
    renderJvmSectionHeader,
    renderConfigSectionCard,
  };
};

export type ConnectionModalSectionRenderersApi = ReturnType<typeof useConnectionModalSectionRenderers>;
