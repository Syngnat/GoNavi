package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// driverDownloadPlan is the validated input of one driver installation.
type driverDownloadPlan struct {
	definition      driverDefinition
	engine          string
	urlText         string
	selectedVersion string
	resolvedDir     string
}

// downloadDriverPackage executes one driver installation with a caller-owned
// context. The Wails method keeps the background context for compatibility
// while background tasks pass their cancellation context through the complete
// download / build / activate path.
func (a *App) downloadDriverPackage(ctx context.Context, driverType string, version string, downloadURL string, downloadDir string) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return a.driverDownloadCanceledResult()
	}

	// 按驱动类型加锁：不同类型可并行，同类型串行（见 driver_install_lock.go）。
	release := a.driverInstallLock.lockDriver(normalizeDriverType(driverType))
	defer release()
	if ctx.Err() != nil {
		return a.driverDownloadCanceledResult()
	}

	plan, failure := a.resolveDriverDownloadPlan(driverType, version, downloadURL, downloadDir)
	if failure != nil {
		return *failure
	}
	// 刻意不在此写 db.SetExternalDriverDownloadDirectory：plan.resolvedDir 会作为
	// 显式参数贯穿整条安装链路（installOptionalDriverAgentPackage / writeInstalledDriverPackage
	// 等），链路内部没有空串回落，因此这次写入既无必要，又会在并发安装时把
	// 进程级全局目录改成「最后一次安装的目录」，污染同时进行的连接解析。
	if db.IsOptionalGoDriver(plan.definition.Type) {
		return a.installOptionalGoDriverPackage(ctx, plan)
	}
	return a.activateEmbeddedGoDriverPackage(ctx, plan)
}

func (a *App) resolveDriverDownloadPlan(driverType string, version string, downloadURL string, downloadDir string) (driverDownloadPlan, *connection.QueryResult) {
	fail := func(message string) (driverDownloadPlan, *connection.QueryResult) {
		return driverDownloadPlan{}, &connection.QueryResult{Success: false, Message: message}
	}
	definition, ok := resolveDriverDefinition(driverType)
	if !ok {
		return fail(a.appText("driver_manager.backend.error.unsupported_driver_type", nil))
	}
	engine := effectiveDriverEngine(definition)
	if definition.BuiltIn {
		return fail(a.appText("driver_manager.backend.error.builtin_download_not_required", nil))
	}
	if err := a.localizeDriverSelectionError(definition, ensureOptionalDriverBuildAvailable(definition)); err != nil {
		return fail(err.Error())
	}
	if !(engine == driverEngineGo && !definition.BuiltIn) {
		return fail(a.appText("driver_manager.backend.error.optional_go_only", nil))
	}

	urlText := strings.TrimSpace(downloadURL)
	if urlText == "" {
		urlText = strings.TrimSpace(definition.DefaultDownloadURL)
	}
	if urlText == "" {
		urlText = fmt.Sprintf("builtin://activate/%s", optionalDriverPublicTypeName(definition.Type))
	}
	selectedVersion := resolveDriverInstallVersion(version, urlText, definition)
	if err := a.localizeDriverSelectionError(definition, validateDriverSelectedVersion(definition, selectedVersion)); err != nil {
		return fail(err.Error())
	}

	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return fail(err.Error())
	}
	return driverDownloadPlan{
		definition:      definition,
		engine:          engine,
		urlText:         urlText,
		selectedVersion: selectedVersion,
		resolvedDir:     resolvedDir,
	}, nil
}

func (a *App) installOptionalGoDriverPackage(ctx context.Context, plan driverDownloadPlan) connection.QueryResult {
	definition := plan.definition
	displayName := a.driverStatusDisplayName(definition)
	startMessage := a.appText("driver_manager.progress.agent_install_start", map[string]any{"name": displayName})
	if v := strings.TrimSpace(plan.selectedVersion); v != "" {
		startMessage = a.appText("driver_manager.progress.agent_install_start_with_version", map[string]any{"name": displayName, "version": v})
	}
	a.emitDriverDownloadProgressContext(ctx, definition.Type, "start", 0, 100, startMessage)
	meta, installErr := installOptionalDriverAgentPackage(ctx, a, definition, plan.selectedVersion, plan.resolvedDir, plan.urlText)
	if installErr != nil {
		if isDriverDownloadCanceled(ctx, installErr) {
			return a.driverDownloadCanceledResult()
		}
		errText := normalizeMixedEncodingText(localizedDriverBackendErrorMessage(a, installErr))
		a.emitDriverDownloadProgressContext(ctx, definition.Type, "error", 0, 0, errText)
		return connection.QueryResult{
			Success: false,
			Message: a.appText("driver_manager.backend.message.download_failed_detail", map[string]any{
				"detail": a.driverOperationErrorMessage(installErr, "failed to download and install driver, driver=%s version=%s url=%s", definition.Type, plan.selectedVersion, plan.urlText),
			}),
		}
	}
	if ctx.Err() != nil {
		return a.driverDownloadCanceledResult()
	}
	a.emitDriverDownloadProgressContext(ctx, definition.Type, "downloading", 95, 100, a.appText("driver_manager.progress.metadata_write", nil))
	if writeErr := writeInstalledDriverPackage(plan.resolvedDir, definition.Type, meta); writeErr != nil {
		return a.driverMetadataWriteFailure(ctx, plan, writeErr)
	}
	a.emitDriverDownloadProgressContext(ctx, definition.Type, "done", 100, 100, a.appText("driver_manager.progress.agent_install_done", map[string]any{"name": displayName}))
	return a.driverInstallSuccessResult(plan)
}

func (a *App) activateEmbeddedGoDriverPackage(ctx context.Context, plan driverDownloadPlan) connection.QueryResult {
	definition := plan.definition
	if ctx.Err() != nil {
		return a.driverDownloadCanceledResult()
	}
	a.emitDriverDownloadProgressContext(ctx, definition.Type, "start", 0, 0, a.appText("driver_manager.progress.install_start", nil))
	meta := installedDriverPackage{
		DriverType:   definition.Type,
		Version:      plan.selectedVersion,
		FilePath:     "",
		FileName:     "embedded-go-driver",
		DownloadURL:  plan.urlText,
		SHA256:       "",
		DownloadedAt: time.Now().Format(time.RFC3339),
	}
	if ctx.Err() != nil {
		return a.driverDownloadCanceledResult()
	}
	if err := writeInstalledDriverPackage(plan.resolvedDir, definition.Type, meta); err != nil {
		return a.driverMetadataWriteFailure(ctx, plan, err)
	}
	a.emitDriverDownloadProgressContext(ctx, definition.Type, "done", 1, 1, a.appText("driver_manager.progress.pure_go_enabled", nil))
	return a.driverInstallSuccessResult(plan)
}

func (a *App) driverMetadataWriteFailure(ctx context.Context, plan driverDownloadPlan, writeErr error) connection.QueryResult {
	if isDriverDownloadCanceled(ctx, writeErr) {
		return a.driverDownloadCanceledResult()
	}
	errText := localizedDriverBackendErrorMessage(a, writeErr)
	a.emitDriverDownloadProgressContext(ctx, plan.definition.Type, "error", 0, 0, errText)
	return connection.QueryResult{
		Success: false,
		Message: a.appText("driver_manager.backend.message.metadata_write_failed_detail", map[string]any{
			"detail": a.driverOperationErrorMessage(writeErr, "failed to write driver metadata, driver=%s version=%s", plan.definition.Type, plan.selectedVersion),
		}),
	}
}

func (a *App) driverInstallSuccessResult(plan driverDownloadPlan) connection.QueryResult {
	return connection.QueryResult{Success: true, Message: a.appText("driver_manager.backend.message.driver_install_success", nil), Data: map[string]interface{}{
		"driverType": plan.definition.Type,
		"driverName": plan.definition.Name,
		"engine":     plan.engine,
	}}
}

func (a *App) driverDownloadCanceledResult() connection.QueryResult {
	return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.message.download_canceled", nil)}
}

// driverDownloadCanceledError wraps the context error so callers can keep
// using errors.Is(err, context.Canceled) while the message stays localized.
func driverDownloadCanceledError(ctx context.Context) error {
	cause := context.Canceled
	if ctx != nil && ctx.Err() != nil {
		cause = ctx.Err()
	}
	return newLocalizedDriverBackendError("driver_manager.backend.message.download_canceled", nil, cause)
}

func isDriverDownloadCanceled(ctx context.Context, err error) bool {
	if ctx != nil && ctx.Err() != nil {
		return true
	}
	return errors.Is(err, context.Canceled)
}
