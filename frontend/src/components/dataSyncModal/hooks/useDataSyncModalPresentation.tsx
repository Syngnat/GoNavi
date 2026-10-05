import React, { useEffect, useMemo } from "react";
import { message } from "antd";
import { RocketOutlined, SwapOutlined } from "@ant-design/icons";
import { DataSyncCapability } from "../../../../wailsjs/go/app/App";
import type { DataSyncCapabilitySnapshot } from "../../dataSyncCapability";
import { resolveRedisDbIndex, resolvePreferredTargetSchema } from "../dataSyncSqlPreview";
import { loadSchemas } from "../../sidebar/sidebarMetadataLoaders";
import { t } from "../../../i18n";
import { resolveTextInputSafeBackdropFilter } from "../../../utils/appearance";
import type { DataSyncModalSyncActionsApi } from "./useDataSyncModalSyncActions";
import type { DataSyncModalStateApi } from "./useDataSyncModalState";
import type { DataSyncModalProps } from "../../DataSyncModal";

export interface UseDataSyncModalPresentationInput {
    isMigrationWorkflow: DataSyncModalSyncActionsApi['isMigrationWorkflow'];
    sourceType: DataSyncModalSyncActionsApi['sourceType'];
    targetType: DataSyncModalSyncActionsApi['targetType'];
    sourceConn: DataSyncModalSyncActionsApi['sourceConn'];
    targetConn: DataSyncModalStateApi['targetConn'];
    setMigrationCapability: DataSyncModalStateApi['setMigrationCapability'];
    setMigrationCapabilityStatus: DataSyncModalStateApi['setMigrationCapabilityStatus'];
    sourceDb: DataSyncModalStateApi['sourceDb'];
    selectedTables: DataSyncModalStateApi['selectedTables'];
    targetDb: DataSyncModalStateApi['targetDb'];
    targetSupportsSchemaSelection: DataSyncModalStateApi['targetSupportsSchemaSelection'];
    setTargetSchemas: DataSyncModalStateApi['setTargetSchemas'];
    setTargetSchema: DataSyncModalStateApi['setTargetSchema'];
    setTargetSchemaLoading: DataSyncModalStateApi['setTargetSchemaLoading'];
    targetDialect: DataSyncModalStateApi['targetDialect'];
    i18nLanguage: DataSyncModalStateApi['i18nLanguage'];
    darkMode: DataSyncModalStateApi['darkMode'];
    disableLocalBackdropFilter: DataSyncModalStateApi['disableLocalBackdropFilter'];
    effectiveOpacity: DataSyncModalStateApi['effectiveOpacity'];
    token: DataSyncModalStateApi['token'];
    onBack: DataSyncModalProps['onBack'];
    syncing: DataSyncModalStateApi['syncing'];
    tr: DataSyncModalStateApi['tr'];
}

export const useDataSyncModalPresentation = ({
    isMigrationWorkflow, sourceType, targetType, sourceConn, targetConn, setMigrationCapability,
    setMigrationCapabilityStatus, sourceDb, selectedTables, targetDb, targetSupportsSchemaSelection,
    setTargetSchemas, setTargetSchema, setTargetSchemaLoading, targetDialect, i18nLanguage,
    darkMode, disableLocalBackdropFilter, effectiveOpacity, token, onBack, syncing, tr,
}: UseDataSyncModalPresentationInput) => {
    const isRedisMongoKeyspaceMigration =
      isMigrationWorkflow &&
      ((sourceType === "redis" && targetType === "mongodb") ||
        (sourceType === "mongodb" && targetType === "redis"));

    useEffect(() => {
      if (!sourceConn || !targetConn) {
        setMigrationCapability(null);
        setMigrationCapabilityStatus("idle");
        return;
      }

      let cancelled = false;
      setMigrationCapability(null);
      setMigrationCapabilityStatus("loading");
      void DataSyncCapability(
        {
          type: String(sourceConn.config?.type || ""),
          driver: String(sourceConn.config?.driver || ""),
          oceanBaseProtocol: String(sourceConn.config?.oceanBaseProtocol || ""),
        } as any,
        {
          type: String(targetConn.config?.type || ""),
          driver: String(targetConn.config?.driver || ""),
          oceanBaseProtocol: String(targetConn.config?.oceanBaseProtocol || ""),
        } as any,
      )
        .then((capability) => {
          if (!cancelled) {
            setMigrationCapability(capability as DataSyncCapabilitySnapshot);
            setMigrationCapabilityStatus("ready");
          }
        })
        .catch(() => {
          if (!cancelled) {
            setMigrationCapability(null);
            setMigrationCapabilityStatus("error");
          }
        });

      return () => {
        cancelled = true;
      };
    }, [sourceConn, targetConn]);
    const defaultMongoCollectionName = useMemo(() => {
      if (sourceType === "redis" && targetType === "mongodb") {
        return `redis_db_${resolveRedisDbIndex(sourceDb || sourceConn?.config?.database)}_keys`;
      }
      if (sourceType === "mongodb" && targetType === "redis") {
        return (
          selectedTables[0] ||
          `redis_db_${resolveRedisDbIndex(targetDb || targetConn?.config?.database)}_keys`
        );
      }
      return "";
    }, [
      sourceType,
      targetType,
      sourceDb,
      targetDb,
      sourceConn,
      targetConn,
      selectedTables,
    ]);

    useEffect(() => {
      if (!targetConn || !targetDb || !targetSupportsSchemaSelection) {
        setTargetSchemas([]);
        setTargetSchema("");
        setTargetSchemaLoading(false);
        return;
      }

      let cancelled = false;
      setTargetSchema("");
      setTargetSchemas([]);
      setTargetSchemaLoading(true);

      (async () => {
        try {
          const result = await loadSchemas(targetConn, targetDb);
          if (cancelled) return;
          const normalizedSchemas = Array.from(
            new Map(
              (Array.isArray(result.schemas) ? result.schemas : [])
                .map((item) => String(item || "").trim())
                .filter((item) => item !== "")
                .map((item) => [item.toLowerCase(), item] as const),
            ).values(),
          );
          setTargetSchemas(normalizedSchemas);
          setTargetSchema(
            resolvePreferredTargetSchema(targetDialect, normalizedSchemas),
          );
        } catch (e: any) {
          if (cancelled) return;
          setTargetSchemas([]);
          setTargetSchema("");
          message.error(
            t(
              "data_sync.message.fetch_target_schemas_failed_detail",
              { detail: e?.message || String(e) },
              i18nLanguage,
            ),
          );
        } finally {
          if (!cancelled) {
            setTargetSchemaLoading(false);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [targetConn, targetDb, targetDialect, targetSupportsSchemaSelection]);

    const modalPanelStyle = useMemo(
      () => ({
        background: darkMode
          ? "linear-gradient(180deg, rgba(16,22,34,0.96) 0%, rgba(10,14,24,0.98) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(246,248,252,0.98) 100%)",
        border: darkMode
          ? "1px solid rgba(255,255,255,0.08)"
          : "1px solid rgba(16,24,40,0.08)",
        boxShadow: darkMode
          ? "0 24px 56px rgba(0,0,0,0.36)"
          : "0 18px 44px rgba(15,23,42,0.14)",
        backdropFilter: resolveTextInputSafeBackdropFilter(
          darkMode ? "blur(18px)" : "none",
          disableLocalBackdropFilter,
        ),
      }),
      [darkMode, disableLocalBackdropFilter],
    );

    const shellCardStyle = useMemo<React.CSSProperties>(
      () => ({
        borderRadius: 18,
        border: darkMode
          ? "1px solid rgba(255,255,255,0.08)"
          : "1px solid rgba(15,23,42,0.08)",
        background: darkMode
          ? "rgba(255,255,255,0.03)"
          : `rgba(255,255,255,${Math.max(effectiveOpacity, 0.88)})`,
        boxShadow: darkMode
          ? "0 12px 32px rgba(0,0,0,0.22)"
          : "0 10px 24px rgba(15,23,42,0.08)",
        overflow: "hidden",
      }),
      [darkMode, effectiveOpacity],
    );

    const heroPanelStyle = useMemo<React.CSSProperties>(
      () => ({
        padding: 18,
        borderRadius: 18,
        border: darkMode
          ? "1px solid rgba(255,214,102,0.12)"
          : "1px solid rgba(24,144,255,0.12)",
        background: darkMode
          ? "linear-gradient(135deg, rgba(255,214,102,0.10) 0%, rgba(255,255,255,0.03) 100%)"
          : "linear-gradient(135deg, rgba(24,144,255,0.10) 0%, rgba(255,255,255,0.95) 100%)",
        marginBottom: 18,
      }),
      [darkMode],
    );

    const badgeStyle = useMemo<React.CSSProperties>(
      () => ({
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 999,
        border: darkMode
          ? "1px solid rgba(255,255,255,0.10)"
          : "1px solid rgba(15,23,42,0.08)",
        background: darkMode
          ? "rgba(255,255,255,0.04)"
          : "rgba(255,255,255,0.86)",
        color: darkMode ? "rgba(255,255,255,0.88)" : "#334155",
        fontSize: 12,
        fontWeight: 600,
      }),
      [darkMode],
    );

    const quietPanelStyle = useMemo<React.CSSProperties>(
      () => ({
        padding: 14,
        borderRadius: 16,
        border: darkMode
          ? "1px solid rgba(255,255,255,0.08)"
          : "1px solid rgba(15,23,42,0.08)",
        background: darkMode
          ? "rgba(255,255,255,0.025)"
          : "rgba(248,250,252,0.92)",
      }),
      [darkMode],
    );

    const modalWorkspaceStyle = useMemo<React.CSSProperties>(
      () => ({
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }),
      [],
    );

    const modalScrollableContentStyle = useMemo<React.CSSProperties>(
      () => ({
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        paddingRight: 4,
        overscrollBehavior: "contain",
      }),
      [],
    );

    const modalFooterBarStyle = useMemo<React.CSSProperties>(
      () => ({
        marginTop: 18,
        display: "flex",
        justifyContent: "flex-end",
        gap: 8,
        paddingTop: 12,
        borderTop: darkMode
          ? "1px solid rgba(255,255,255,0.06)"
          : "1px solid rgba(15,23,42,0.06)",
        flex: "0 0 auto",
      }),
      [darkMode],
    );

    const renderModalTitle = (title: string, description: string) => (
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          minWidth: 0,
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 14,
            display: "grid",
            placeItems: "center",
            background: darkMode
              ? "rgba(255,214,102,0.12)"
              : "rgba(24,144,255,0.10)",
            color: darkMode ? "#ffd666" : token.colorPrimary,
            flexShrink: 0,
          }}
        >
          {isMigrationWorkflow ? <RocketOutlined /> : <SwapOutlined />}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: darkMode ? "#f8fafc" : "#0f172a",
            }}
          >
            {title}
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 12,
              lineHeight: 1.6,
              color: darkMode ? "rgba(255,255,255,0.56)" : "rgba(15,23,42,0.58)",
            }}
          >
            {description}
          </div>
        </div>
      </div>
    );

    const handleReturnToPrevious = () => {
      if (syncing) {
        message.warning(tr("data_sync.message.close_blocked_running"));
        return;
      }
      onBack?.();
    };
    return {
        isRedisMongoKeyspaceMigration, defaultMongoCollectionName, modalPanelStyle, shellCardStyle,
        heroPanelStyle, badgeStyle, quietPanelStyle, modalWorkspaceStyle,
        modalScrollableContentStyle, modalFooterBarStyle, renderModalTitle, handleReturnToPrevious,
    };
};

export type DataSyncModalPresentationApi = ReturnType<typeof useDataSyncModalPresentation>;
