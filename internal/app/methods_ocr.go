package app

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ocr"
	"GoNavi-Wails/internal/uievents"
)

// The optional text-recognition component: the person agrees to download it, it is
// kept in the application's data directory, and it can be removed again. The
// recognition itself runs in the web view; these methods only manage the files and
// hand out the address the worker loads them from. See internal/ocr.

const ocrInstallProgressEvent = "ocr:install-progress"

var (
	// ocrComponentSource and ocrHTTPClient are variables so tests can point the
	// installer at a local server instead of the real download sources.
	ocrComponentSource = ocr.DefaultComponent
	ocrHTTPClient      = func() *http.Client { return newStrictHTTPClientWithGlobalProxy(0) }

	// One manager per data directory, created on first use. (A registry rather than
	// an App field: app.go may not grow.)
	ocrManagers = struct {
		sync.Mutex
		byRoot map[string]*ocr.Manager
	}{byRoot: map[string]*ocr.Manager{}}
)

type ocrStatusData struct {
	Installed  bool     `json:"installed"`
	Installing bool     `json:"installing"`
	Version    string   `json:"version"`
	Languages  []string `json:"languages"`
	SizeBytes  int64    `json:"sizeBytes"`
	Path       string   `json:"path"`
	// Canceled is set on the result of an installation the person canceled, which
	// is not a failure to report.
	Canceled bool `json:"canceled,omitempty"`
}

type ocrInstallProgressPayload struct {
	Phase      string  `json:"phase"`
	File       string  `json:"file,omitempty"`
	Downloaded int64   `json:"downloaded"`
	Total      int64   `json:"total"`
	Percent    float64 `json:"percent"`
}

// ocrManager returns the manager for this installation's data directory, or the
// result to hand back when the component cannot be used: not in the browser-served
// web runtime (the files are served on this machine's loopback, which a remote
// browser cannot reach), and not before the data directory is known.
func (a *App) ocrManager() (*ocr.Manager, *connection.QueryResult) {
	if a != nil && a.webRuntime {
		return nil, &connection.QueryResult{Success: false, Message: a.appText("ocr_component.backend.error.desktop_only", nil)}
	}
	dir := ConfigDirForIntegration(a)
	if dir == "" {
		return nil, &connection.QueryResult{Success: false, Message: a.appText("ocr_component.backend.error.unavailable", nil)}
	}
	root := filepath.Join(dir, "ocr")
	ocrManagers.Lock()
	defer ocrManagers.Unlock()
	manager, ok := ocrManagers.byRoot[root]
	if !ok {
		manager = ocr.NewManager(root, ocrComponentSource(), ocrHTTPClient())
		ocrManagers.byRoot[root] = manager
	}
	return manager, nil
}

func ocrStatusPayload(status ocr.Status) ocrStatusData {
	return ocrStatusData{
		Installed: status.Installed, Installing: status.Installing, Version: status.Version,
		Languages: status.Languages, SizeBytes: status.SizeBytes, Path: status.Path,
	}
}

// OCRGetStatus reports whether the component is installed, what it is made of and
// how large it is, for the settings page and the first-use prompt.
func (a *App) OCRGetStatus() connection.QueryResult {
	manager, refusal := a.ocrManager()
	if refusal != nil {
		return *refusal
	}
	return connection.QueryResult{Success: true, Data: ocrStatusPayload(manager.Status())}
}

// OCRInstall downloads and verifies the component, reporting progress through the
// ocr:install-progress event, and returns when it is done, failed or canceled.
func (a *App) OCRInstall() connection.QueryResult {
	manager, refusal := a.ocrManager()
	if refusal != nil {
		return *refusal
	}
	err := manager.Install(context.Background(), a.emitOCRInstallProgress)
	status := ocrStatusPayload(manager.Status())
	switch {
	case err == nil:
		return connection.QueryResult{Success: true, Message: a.appText("ocr_component.backend.message.installed", nil), Data: status}
	case errors.Is(err, ocr.ErrInstallInProgress):
		return connection.QueryResult{Success: false, Message: a.appText("ocr_component.backend.error.install_in_progress", nil), Data: status}
	case errors.Is(err, context.Canceled):
		status.Canceled = true
		return connection.QueryResult{Success: false, Message: a.appText("ocr_component.backend.message.install_canceled", nil), Data: status}
	}
	logger.Warnf("图片识别组件安装失败：%v", err)
	return connection.QueryResult{Success: false, Data: status, Message: a.appText("ocr_component.backend.error.install_failed", map[string]any{"detail": err.Error()})}
}

// OCRCancelInstall stops a running installation; OCRInstall then returns as canceled.
func (a *App) OCRCancelInstall() connection.QueryResult {
	manager, refusal := a.ocrManager()
	if refusal != nil {
		return *refusal
	}
	manager.CancelInstall()
	return connection.QueryResult{Success: true}
}

// OCRRemove deletes the downloaded component.
func (a *App) OCRRemove() connection.QueryResult {
	manager, refusal := a.ocrManager()
	if refusal != nil {
		return *refusal
	}
	if err := manager.Remove(); err != nil {
		if errors.Is(err, ocr.ErrInstallInProgress) {
			return connection.QueryResult{Success: false, Message: a.appText("ocr_component.backend.error.install_in_progress", nil)}
		}
		logger.Warnf("图片识别组件删除失败：%v", err)
		return connection.QueryResult{Success: false, Message: a.appText("ocr_component.backend.error.remove_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Message: a.appText("ocr_component.backend.message.removed", nil), Data: ocrStatusPayload(manager.Status())}
}

// OCRServe starts the local file service (if it is not running) and returns the URL
// prefix and languages the recognition worker is configured with.
func (a *App) OCRServe() connection.QueryResult {
	manager, refusal := a.ocrManager()
	if refusal != nil {
		return *refusal
	}
	baseURL, err := manager.Serve()
	if errors.Is(err, ocr.ErrNotInstalled) {
		return connection.QueryResult{Success: false, Message: a.appText("ocr_component.backend.error.not_installed", nil), Data: ocrStatusPayload(manager.Status())}
	}
	if err != nil {
		logger.Warnf("图片识别服务启动失败：%v", err)
		return connection.QueryResult{Success: false, Message: a.appText("ocr_component.backend.error.serve_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]any{
		"baseUrl":   strings.TrimRight(baseURL, "/"),
		"languages": manager.Status().Languages,
	}}
}

func (a *App) emitOCRInstallProgress(progress ocr.Progress) {
	if a == nil || a.ctx == nil {
		return
	}
	payload := ocrInstallProgressPayload{Phase: progress.Phase, File: progress.File, Downloaded: progress.Downloaded, Total: progress.Total}
	if progress.Total > 0 {
		payload.Percent = float64(progress.Downloaded) / float64(progress.Total) * 100
	}
	uievents.Emit(a.ctx, ocrInstallProgressEvent, payload)
}
