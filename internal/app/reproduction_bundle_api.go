package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/requesttrace"
	"GoNavi-Wails/internal/syncjob"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const reproductionBundleSourceLimit = 200

type reproductionBundleSourceRef struct {
	Kind reproductionBundleSourceKind `json:"kind"`
	ID   string                       `json:"id"`
}

type reproductionBundleSourceSummary struct {
	Kind      reproductionBundleSourceKind `json:"kind"`
	ID        string                       `json:"id"`
	Label     string                       `json:"label"`
	Status    string                       `json:"status"`
	ErrorKind string                       `json:"errorKind,omitempty"`
	UpdatedAt int64                        `json:"updatedAt,omitempty"`
}

type reproductionBundleSourcePage struct {
	Items    []reproductionBundleSourceSummary `json:"items"`
	Warnings []string                          `json:"warnings"`
}

type reproductionBundleExportPayload struct {
	FileName string `json:"fileName"`
	MimeType string `json:"mimeType"`
	Content  string `json:"content"`
}

func (a *App) ListReproductionBundleSources() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is unavailable"}
	}
	page := reproductionBundleSourcePage{Items: make([]reproductionBundleSourceSummary, 0)}
	for _, trace := range a.requestDiagnostics().List(requesttrace.Filter{Limit: reproductionBundleSourceLimit}).Items {
		if !reproductionBundleTraceFailed(trace) {
			continue
		}
		kind := reproductionBundleSourceQuery
		if strings.EqualFold(trace.Entry, "mcp") {
			kind = reproductionBundleSourceMCP
		}
		errorKind := "execution"
		if trace.Error != nil {
			errorKind = sanitizeReproductionBundleErrorKind(trace.Error.Kind)
		}
		page.Items = append(page.Items, reproductionBundleSourceSummary{
			Kind: kind, ID: trace.RequestID, Label: reproductionBundleSourceLabel(kind), Status: trace.Status,
			ErrorKind: errorKind, UpdatedAt: maxDiagnosticInt64(trace.StartedAt, trace.FinishedAt),
		})
	}

	if store, err := a.ensureImportJobStore(); err != nil {
		page.Warnings = append(page.Warnings, "import failures unavailable")
	} else if jobs, listErr := store.List(); listErr != nil {
		var warning *importjob.CorruptJobFilesWarning
		if errors.As(listErr, &warning) {
			page.Warnings = append(page.Warnings, "some import failure records were unreadable")
			page.Items = append(page.Items, reproductionBundleImportSourceSummaries(jobs)...)
		} else {
			page.Warnings = append(page.Warnings, "import failures unavailable")
		}
	} else {
		page.Items = append(page.Items, reproductionBundleImportSourceSummaries(jobs)...)
	}

	if manager, err := a.ensureDataSyncJobManager(); err != nil {
		page.Warnings = append(page.Warnings, "sync failures unavailable")
	} else if runs, listErr := manager.ListRuns(context.Background(), "", reproductionBundleSourceLimit); listErr != nil {
		page.Warnings = append(page.Warnings, "sync failures unavailable")
	} else {
		for _, run := range runs {
			if !reproductionBundleSyncRunFailed(run.Status) {
				continue
			}
			page.Items = append(page.Items, reproductionBundleSourceSummary{
				Kind: reproductionBundleSourceSync, ID: run.ID, Label: reproductionBundleSourceLabel(reproductionBundleSourceSync),
				Status: string(run.Status), ErrorKind: sanitizeReproductionBundleErrorKind("sync_" + string(run.Status)),
				UpdatedAt: maxDiagnosticInt64(run.StartedAt, run.FinishedAt),
			})
		}
	}

	sortReproductionBundleSourceSummaries(page.Items)
	if len(page.Items) > reproductionBundleSourceLimit {
		page.Items = page.Items[:reproductionBundleSourceLimit]
	}
	return connection.QueryResult{Success: true, Data: page}
}

func (a *App) BuildReproductionBundle(kind, sourceID string) connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is unavailable"}
	}
	payload, err := a.buildReproductionBundleExport(reproductionBundleSourceRef{Kind: reproductionBundleSourceKind(kind), ID: sourceID})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: payload}
}

func (a *App) ExportReproductionBundle(kind, sourceID string) connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is unavailable"}
	}
	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: "desktop file export is unavailable in web runtime; use BuildReproductionBundle"}
	}
	payload, err := a.buildReproductionBundleExport(reproductionBundleSourceRef{Kind: reproductionBundleSourceKind(kind), ID: sourceID})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title: "Export minimal reproduction bundle", DefaultFilename: payload.FileName,
		Filters: []runtime.FileFilter{{DisplayName: "JSON", Pattern: "*.json"}},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(target) == "" {
		return connection.QueryResult{Success: false, Message: "cancelled"}
	}
	target, err = a.resolveExportDialogTargetPath(target, "json")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := a.validateDatabaseDiagnosticExportTarget(target); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := writeDatabaseDiagnosticPackageAtomically(target, []byte(payload.Content)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]string{"path": target}}
}

func (a *App) PreviewReproductionBundle(content string) connection.QueryResult {
	preview, err := previewReproductionBundle(content)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: preview}
}

func (a *App) ReplayReproductionBundle(content string) connection.QueryResult {
	replay, err := replayReproductionBundle(content)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: replay}
}

func (a *App) buildReproductionBundleExport(source reproductionBundleSourceRef) (reproductionBundleExportPayload, error) {
	snapshot, err := a.resolveReproductionBundleSnapshot(source)
	if err != nil {
		return reproductionBundleExportPayload{}, err
	}
	bundle := buildReproductionBundle(snapshot, getCurrentVersion(), time.Now())
	content, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return reproductionBundleExportPayload{}, err
	}
	return reproductionBundleExportPayload{
		FileName: fmt.Sprintf("gonavi-reproduction-%s-%s.json", source.Kind, time.Now().Format("20060102-150405")),
		MimeType: "application/json;charset=utf-8", Content: string(content),
	}, nil
}

func (a *App) resolveReproductionBundleSnapshot(source reproductionBundleSourceRef) (reproductionBundleSnapshot, error) {
	if !validReproductionBundleSourceKind(source.Kind) || strings.TrimSpace(source.ID) == "" {
		return reproductionBundleSnapshot{}, errors.New("invalid reproduction bundle source")
	}
	switch source.Kind {
	case reproductionBundleSourceQuery, reproductionBundleSourceMCP:
		trace, found := a.requestDiagnostics().Get(strings.TrimSpace(source.ID))
		if !found || !reproductionBundleTraceFailed(trace) {
			return reproductionBundleSnapshot{}, errors.New("failed request trace was not found or has expired")
		}
		isMCP := strings.EqualFold(trace.Entry, "mcp")
		if (source.Kind == reproductionBundleSourceMCP) != isMCP {
			return reproductionBundleSnapshot{}, errors.New("request trace entry does not match reproduction source kind")
		}
		return reproductionBundleSnapshotFromTrace(trace, source.Kind), nil
	case reproductionBundleSourceImport:
		store, err := a.ensureImportJobStore()
		if err != nil {
			return reproductionBundleSnapshot{}, err
		}
		job, err := store.Get(strings.TrimSpace(source.ID))
		if err != nil || !reproductionBundleImportJobFailed(job.Status) {
			return reproductionBundleSnapshot{}, errors.New("failed import task was not found")
		}
		return reproductionBundleSnapshotFromImport(job), nil
	case reproductionBundleSourceSync:
		manager, err := a.ensureDataSyncJobManager()
		if err != nil {
			return reproductionBundleSnapshot{}, err
		}
		run, err := manager.GetRun(context.Background(), strings.TrimSpace(source.ID))
		if err != nil || !reproductionBundleSyncRunFailed(run.Status) {
			return reproductionBundleSnapshot{}, errors.New("failed data sync run was not found")
		}
		job, err := manager.GetJob(context.Background(), run.JobID)
		if err != nil {
			return reproductionBundleSnapshot{}, errors.New("data sync task definition was not found")
		}
		events, err := manager.ListRunEvents(context.Background(), run.ID, 0, 500)
		if err != nil {
			return reproductionBundleSnapshot{}, err
		}
		return reproductionBundleSnapshotFromSync(run, job, events), nil
	default:
		return reproductionBundleSnapshot{}, errors.New("unsupported reproduction bundle source")
	}
}

func reproductionBundleImportSourceSummaries(jobs []importjob.Job) []reproductionBundleSourceSummary {
	result := make([]reproductionBundleSourceSummary, 0, len(jobs))
	for _, job := range jobs {
		if reproductionBundleImportJobFailed(job.Status) {
			result = append(result, reproductionBundleSourceSummary{
				Kind: reproductionBundleSourceImport, ID: job.ID, Label: reproductionBundleSourceLabel(reproductionBundleSourceImport),
				Status: string(job.Status), ErrorKind: sanitizeReproductionBundleErrorKind("import_" + string(job.Status)), UpdatedAt: job.UpdatedAt,
			})
		}
	}
	return result
}

func reproductionBundleTraceFailed(trace requesttrace.Trace) bool {
	status := strings.ToLower(strings.TrimSpace(trace.Status))
	return status == "error" || status == "cancelled"
}

func reproductionBundleImportJobFailed(status importjob.Status) bool {
	switch status {
	case importjob.StatusPartial, importjob.StatusFailed, importjob.StatusCancelled, importjob.StatusUnknown, importjob.StatusInterrupted:
		return true
	default:
		return false
	}
}

func reproductionBundleSyncRunFailed(status syncjob.RunStatus) bool {
	switch status {
	case syncjob.RunStatusPartial, syncjob.RunStatusFailed, syncjob.RunStatusCanceled, syncjob.RunStatusInterrupted:
		return true
	default:
		return false
	}
}

func reproductionBundleSourceLabel(kind reproductionBundleSourceKind) string {
	switch kind {
	case reproductionBundleSourceQuery:
		return "Query failure"
	case reproductionBundleSourceSync:
		return "Data sync failure"
	case reproductionBundleSourceImport:
		return "Import failure"
	case reproductionBundleSourceMCP:
		return "MCP failure"
	default:
		return "Failure"
	}
}

func sortReproductionBundleSourceSummaries(items []reproductionBundleSourceSummary) {
	sort.SliceStable(items, func(left, right int) bool {
		if items[left].UpdatedAt == items[right].UpdatedAt {
			if items[left].Kind == items[right].Kind {
				return items[left].ID < items[right].ID
			}
			return items[left].Kind < items[right].Kind
		}
		return items[left].UpdatedAt > items[right].UpdatedAt
	})
}
