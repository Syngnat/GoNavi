package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/requesttrace"
	"GoNavi-Wails/internal/syncjob"
)

const (
	reproductionBundleSchemaVersion = 1
	reproductionBundleFormat        = "gonavi-reproduction-bundle"
	reproductionBundleFixtureEngine = "gonavi-fake-v1"
	reproductionBundleMaxBytes      = 1 << 20
)

var (
	reproductionBundleIDPattern    = regexp.MustCompile(`^source-[0-9a-f]{16}$`)
	reproductionBundleLabelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$`)
)

type reproductionBundleSourceKind string

const (
	reproductionBundleSourceQuery  reproductionBundleSourceKind = "query"
	reproductionBundleSourceSync   reproductionBundleSourceKind = "sync"
	reproductionBundleSourceImport reproductionBundleSourceKind = "import"
	reproductionBundleSourceMCP    reproductionBundleSourceKind = "mcp"
)

type reproductionBundle struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Format        string                      `json:"format"`
	AppVersion    string                      `json:"appVersion"`
	GeneratedAt   int64                       `json:"generatedAt"`
	Source        reproductionBundleSource    `json:"source"`
	Capabilities  map[string]string           `json:"capabilities"`
	Events        []reproductionBundleEvent   `json:"events"`
	Fixture       reproductionBundleFixture   `json:"fixture"`
	Redaction     reproductionBundleRedaction `json:"redaction"`
}

type reproductionBundleSource struct {
	Kind       reproductionBundleSourceKind `json:"kind"`
	ID         string                       `json:"id"`
	Status     string                       `json:"status"`
	ErrorKind  string                       `json:"errorKind"`
	StartedAt  int64                        `json:"startedAt,omitempty"`
	FinishedAt int64                        `json:"finishedAt,omitempty"`
}

type reproductionBundleEvent struct {
	OffsetMs int64  `json:"offsetMs"`
	Name     string `json:"name"`
	Status   string `json:"status,omitempty"`
	Stage    string `json:"stage,omitempty"`
	Current  int64  `json:"current,omitempty"`
	Total    int64  `json:"total,omitempty"`
}

type reproductionBundleFixture struct {
	Engine   string                            `json:"engine"`
	Input    reproductionBundleFixtureInput    `json:"input"`
	Expected reproductionBundleFixtureExpected `json:"expected"`
}

type reproductionBundleFixtureInput struct {
	SourceKind   reproductionBundleSourceKind `json:"sourceKind"`
	Capabilities map[string]string            `json:"capabilities"`
	FailureKind  string                       `json:"failureKind"`
	Events       []reproductionBundleEvent    `json:"events"`
}

type reproductionBundleFixtureExpected struct {
	Status     string `json:"status"`
	ErrorKind  string `json:"errorKind"`
	EventCount int    `json:"eventCount"`
}

type reproductionBundleRedaction struct {
	Credentials      string `json:"credentials"`
	DSN              string `json:"dsn"`
	SQLLiterals      string `json:"sqlLiterals"`
	BusinessValues   string `json:"businessValues"`
	SensitivePaths   string `json:"sensitivePaths"`
	RawErrorMessages string `json:"rawErrorMessages"`
}

type reproductionBundleSnapshot struct {
	Kind         reproductionBundleSourceKind
	ID           string
	Status       string
	ErrorKind    string
	StartedAt    int64
	FinishedAt   int64
	Capabilities map[string]string
	Events       []reproductionBundleEvent
}

type reproductionBundlePreview struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Format        string                      `json:"format"`
	AppVersion    string                      `json:"appVersion"`
	Source        reproductionBundleSource    `json:"source"`
	Capabilities  map[string]string           `json:"capabilities"`
	EventCount    int                         `json:"eventCount"`
	FixtureEngine string                      `json:"fixtureEngine"`
	OfflineOnly   bool                        `json:"offlineOnly"`
	Redaction     reproductionBundleRedaction `json:"redaction"`
}

type reproductionBundleReplayResult struct {
	Reproduced bool                         `json:"reproduced"`
	Engine     string                       `json:"engine"`
	SourceKind reproductionBundleSourceKind `json:"sourceKind"`
	Status     string                       `json:"status"`
	ErrorKind  string                       `json:"errorKind"`
	Events     []reproductionBundleEvent    `json:"events"`
}

func reproductionBundleSnapshotFromTrace(trace requesttrace.Trace, kind reproductionBundleSourceKind) reproductionBundleSnapshot {
	errorKind := "execution"
	if trace.Error != nil && strings.TrimSpace(trace.Error.Kind) != "" {
		errorKind = trace.Error.Kind
	}
	if strings.EqualFold(trace.Status, "cancelled") {
		errorKind = "cancelled"
	}
	capabilities := map[string]string{
		"entry":          trace.Entry,
		"operation":      trace.Operation,
		"dataSourceType": trace.DataSourceType,
		"driverMode":     trace.DriverMode,
		"paginationMode": trace.Pagination.Mode,
		"retryCount":     strconv.Itoa(maxDiagnosticInt(trace.RetryCount)),
		"cancellation":   trace.Cancellation.Outcome,
	}
	events := make([]reproductionBundleEvent, 0, len(trace.Events))
	for _, event := range trace.Events {
		events = append(events, reproductionBundleEvent{
			OffsetMs: reproductionBundleOffset(trace.StartedAt, event.Timestamp),
			Name:     event.Name,
		})
	}
	if len(events) == 0 {
		events = append(events, reproductionBundleEvent{Name: "request.failed"})
	}
	return reproductionBundleSnapshot{
		Kind:         kind,
		ID:           trace.RequestID,
		Status:       trace.Status,
		ErrorKind:    errorKind,
		StartedAt:    trace.StartedAt,
		FinishedAt:   trace.FinishedAt,
		Capabilities: capabilities,
		Events:       events,
	}
}

func reproductionBundleSnapshotFromSync(run syncjob.RunRecord, job syncjob.JobDefinition, events []syncjob.RunEvent) reproductionBundleSnapshot {
	mappingCount, columnMappingCount, transformKinds := reproductionBundleSyncMappingSummary(job.Mappings)
	capabilities := map[string]string{
		"jobKind":            string(job.Kind),
		"incrementalMode":    string(job.IncrementalMode),
		"scheduleKind":       string(job.Schedule.Kind),
		"errorPolicy":        string(job.Options.ErrorPolicy),
		"syncMode":           job.Options.SyncMode,
		"targetStrategy":     job.Options.TargetTableStrategy,
		"mappingCount":       strconv.Itoa(mappingCount),
		"columnMappingCount": strconv.Itoa(columnMappingCount),
		"transformKinds":     transformKinds,
		"batchSize":          strconv.Itoa(maxDiagnosticInt(job.Options.BatchSize)),
		"maxRetries":         strconv.Itoa(maxDiagnosticInt(job.Options.MaxRetries)),
		"autoAddColumns":     strconv.FormatBool(job.AutoAddColumnsEnabled()),
		"createIndexes":      strconv.FormatBool(job.Options.CreateIndexes),
		"propagateDeletes":   strconv.FormatBool(job.Options.PropagateDeletes),
		"captureErrorRows":   strconv.FormatBool(job.Options.CaptureErrorPayload),
		"resumable":          strconv.FormatBool(run.Resumable),
		"trigger":            string(run.Trigger),
	}
	bundleEvents := make([]reproductionBundleEvent, 0, len(events))
	for _, event := range events {
		bundleEvents = append(bundleEvents, reproductionBundleEvent{
			OffsetMs: reproductionBundleOffset(run.StartedAt, event.CreatedAt),
			Name:     string(event.Type),
			Status:   string(event.Status),
			Stage:    event.Stage,
			Current:  int64(maxDiagnosticInt(event.Current)),
			Total:    int64(maxDiagnosticInt(event.Total)),
		})
	}
	if len(bundleEvents) == 0 {
		bundleEvents = append(bundleEvents, reproductionBundleEvent{Name: string(run.Status), Status: string(run.Status), Stage: run.Stage})
	}
	return reproductionBundleSnapshot{
		Kind:         reproductionBundleSourceSync,
		ID:           run.ID,
		Status:       string(run.Status),
		ErrorKind:    "sync_" + string(run.Status),
		StartedAt:    run.StartedAt,
		FinishedAt:   run.FinishedAt,
		Capabilities: capabilities,
		Events:       bundleEvents,
	}
}

func reproductionBundleSnapshotFromImport(job importjob.Job) reproductionBundleSnapshot {
	capabilities := map[string]string{
		"importKind":     string(job.Kind),
		"stage":          job.Stage,
		"checkpointSafe": strconv.FormatBool(job.Checkpoint.Safe),
		"resumable":      strconv.FormatBool(job.Resumable),
		"outcomeUnknown": strconv.FormatBool(job.OutcomeUnknown),
		"recoveryAction": job.RecoveryAction,
	}
	if options := job.TableImportOptions; options != nil {
		capabilities["columnMappingCount"] = strconv.Itoa(len(options.ColumnMappings))
		capabilities["encoding"] = options.Encoding
		capabilities["delimiter"] = reproductionBundleDelimiterKind(options.Delimiter)
		capabilities["headerRow"] = strconv.Itoa(maxDiagnosticInt(options.HeaderRow))
		capabilities["emptyStringAsNull"] = strconv.FormatBool(options.EmptyStringAsNull)
		capabilities["conflictPolicy"] = options.ConflictPolicy
		capabilities["conflictKeyCount"] = strconv.Itoa(len(options.ConflictKeyColumns))
	}
	events := []reproductionBundleEvent{{Name: "import.created"}}
	if stage := sanitizeReproductionBundleLabel(job.Stage); stage != "" {
		events = append(events, reproductionBundleEvent{Name: "import.stage", Stage: stage})
	}
	events = append(events, reproductionBundleEvent{
		OffsetMs: reproductionBundleOffset(job.CreatedAt, job.UpdatedAt),
		Name:     "import." + string(job.Status),
		Status:   string(job.Status),
		Stage:    job.Stage,
		Current:  maxDiagnosticInt64(0, job.Current),
		Total:    maxDiagnosticInt64(0, job.Total),
	})
	return reproductionBundleSnapshot{
		Kind:         reproductionBundleSourceImport,
		ID:           job.ID,
		Status:       string(job.Status),
		ErrorKind:    "import_" + string(job.Status),
		StartedAt:    job.CreatedAt,
		FinishedAt:   job.UpdatedAt,
		Capabilities: capabilities,
		Events:       events,
	}
}

func buildReproductionBundle(snapshot reproductionBundleSnapshot, appVersion string, now time.Time) reproductionBundle {
	capabilities := sanitizeReproductionBundleCapabilities(snapshot.Capabilities)
	events := sanitizeReproductionBundleEvents(snapshot.Events)
	status := reproductionBundleFailureStatus(snapshot.Status)
	errorKind := sanitizeReproductionBundleErrorKind(snapshot.ErrorKind)
	redaction := defaultReproductionBundleRedaction()
	return reproductionBundle{
		SchemaVersion: reproductionBundleSchemaVersion,
		Format:        reproductionBundleFormat,
		AppVersion:    sanitizeReproductionBundleVersion(appVersion),
		GeneratedAt:   now.UnixMilli(),
		Source: reproductionBundleSource{
			Kind:       snapshot.Kind,
			ID:         reproductionBundleIdentifier(snapshot.ID),
			Status:     status,
			ErrorKind:  errorKind,
			StartedAt:  maxDiagnosticInt64(0, snapshot.StartedAt),
			FinishedAt: maxDiagnosticInt64(0, snapshot.FinishedAt),
		},
		Capabilities: capabilities,
		Events:       events,
		Fixture: reproductionBundleFixture{
			Engine: reproductionBundleFixtureEngine,
			Input: reproductionBundleFixtureInput{
				SourceKind:   snapshot.Kind,
				Capabilities: cloneReproductionBundleCapabilities(capabilities),
				FailureKind:  errorKind,
				Events:       append([]reproductionBundleEvent(nil), events...),
			},
			Expected: reproductionBundleFixtureExpected{
				Status:     status,
				ErrorKind:  errorKind,
				EventCount: len(events),
			},
		},
		Redaction: redaction,
	}
}

func previewReproductionBundle(content string) (reproductionBundlePreview, error) {
	bundle, err := decodeReproductionBundle(content)
	if err != nil {
		return reproductionBundlePreview{}, err
	}
	return reproductionBundlePreview{
		SchemaVersion: bundle.SchemaVersion,
		Format:        bundle.Format,
		AppVersion:    bundle.AppVersion,
		Source:        bundle.Source,
		Capabilities:  cloneReproductionBundleCapabilities(bundle.Capabilities),
		EventCount:    len(bundle.Events),
		FixtureEngine: bundle.Fixture.Engine,
		OfflineOnly:   true,
		Redaction:     bundle.Redaction,
	}, nil
}

func replayReproductionBundle(content string) (reproductionBundleReplayResult, error) {
	bundle, err := decodeReproductionBundle(content)
	if err != nil {
		return reproductionBundleReplayResult{}, err
	}
	events := append([]reproductionBundleEvent(nil), bundle.Fixture.Input.Events...)
	status := "failed"
	errorKind := bundle.Fixture.Input.FailureKind
	return reproductionBundleReplayResult{
		Reproduced: status == bundle.Fixture.Expected.Status &&
			errorKind == bundle.Fixture.Expected.ErrorKind &&
			len(events) == bundle.Fixture.Expected.EventCount,
		Engine:     bundle.Fixture.Engine,
		SourceKind: bundle.Fixture.Input.SourceKind,
		Status:     status,
		ErrorKind:  errorKind,
		Events:     events,
	}, nil
}

func decodeReproductionBundle(content string) (reproductionBundle, error) {
	if len(content) == 0 {
		return reproductionBundle{}, errors.New("reproduction bundle is empty")
	}
	if len(content) > reproductionBundleMaxBytes {
		return reproductionBundle{}, fmt.Errorf("reproduction bundle exceeds %d bytes", reproductionBundleMaxBytes)
	}
	decoder := json.NewDecoder(bytes.NewBufferString(content))
	decoder.DisallowUnknownFields()
	var bundle reproductionBundle
	if err := decoder.Decode(&bundle); err != nil {
		return reproductionBundle{}, fmt.Errorf("decode reproduction bundle: %w", err)
	}
	if err := ensureReproductionBundleEOF(decoder); err != nil {
		return reproductionBundle{}, err
	}
	if err := validateReproductionBundle(bundle); err != nil {
		return reproductionBundle{}, err
	}
	return bundle, nil
}

func ensureReproductionBundleEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return fmt.Errorf("decode reproduction bundle trailer: %w", err)
	}
	return errors.New("reproduction bundle contains multiple JSON values")
}

func validateReproductionBundle(bundle reproductionBundle) error {
	if bundle.SchemaVersion != reproductionBundleSchemaVersion || bundle.Format != reproductionBundleFormat {
		return errors.New("unsupported reproduction bundle format")
	}
	if !validReproductionBundleSourceKind(bundle.Source.Kind) || bundle.Source.Status != "failed" || !reproductionBundleIDPattern.MatchString(bundle.Source.ID) {
		return errors.New("invalid reproduction bundle source")
	}
	if sanitizeReproductionBundleVersion(bundle.AppVersion) != bundle.AppVersion || bundle.GeneratedAt <= 0 {
		return errors.New("invalid reproduction bundle version metadata")
	}
	if bundle.Fixture.Engine != reproductionBundleFixtureEngine || bundle.Fixture.Input.SourceKind != bundle.Source.Kind {
		return errors.New("unsupported reproduction fixture")
	}
	if bundle.Fixture.Input.FailureKind != bundle.Source.ErrorKind {
		return errors.New("reproduction fixture input does not match source")
	}
	if bundle.Fixture.Expected.Status != "failed" ||
		sanitizeReproductionBundleErrorKind(bundle.Fixture.Expected.ErrorKind) != bundle.Fixture.Expected.ErrorKind ||
		bundle.Fixture.Expected.EventCount < 0 || bundle.Fixture.Expected.EventCount > 500 {
		return errors.New("invalid reproduction fixture expectation")
	}
	if !equalReproductionBundleCapabilities(bundle.Capabilities, bundle.Fixture.Input.Capabilities) {
		return errors.New("reproduction fixture capabilities do not match bundle")
	}
	if !equalReproductionBundleEvents(bundle.Events, bundle.Fixture.Input.Events) {
		return errors.New("reproduction fixture input events do not match bundle")
	}
	if err := validateReproductionBundleCapabilities(bundle.Capabilities); err != nil {
		return err
	}
	if err := validateReproductionBundleEvents(bundle.Events); err != nil {
		return err
	}
	if sanitizeReproductionBundleErrorKind(bundle.Source.ErrorKind) != bundle.Source.ErrorKind {
		return errors.New("invalid reproduction bundle error kind")
	}
	if bundle.Redaction != defaultReproductionBundleRedaction() {
		return errors.New("reproduction bundle redaction manifest is incomplete")
	}
	return nil
}

func sanitizeReproductionBundleCapabilities(input map[string]string) map[string]string {
	result := make(map[string]string, len(input))
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !validReproductionBundleCapabilityKey(key) {
			continue
		}
		if value := sanitizeReproductionBundleLabel(input[key]); value != "" {
			result[key] = value
		}
	}
	return result
}

func validateReproductionBundleCapabilities(capabilities map[string]string) error {
	for key, value := range capabilities {
		if !validReproductionBundleCapabilityKey(key) || sanitizeReproductionBundleLabel(value) != value {
			return fmt.Errorf("invalid reproduction capability %q", key)
		}
	}
	return nil
}

func validReproductionBundleCapabilityKey(value string) bool {
	switch value {
	case "entry", "operation", "dataSourceType", "driverMode", "paginationMode", "retryCount", "cancellation",
		"jobKind", "incrementalMode", "scheduleKind", "errorPolicy", "syncMode", "targetStrategy", "mappingCount",
		"columnMappingCount", "transformKinds", "batchSize", "maxRetries", "autoAddColumns", "createIndexes",
		"propagateDeletes", "captureErrorRows", "resumable", "trigger",
		"importKind", "stage", "checkpointSafe", "outcomeUnknown", "recoveryAction", "encoding", "delimiter",
		"headerRow", "emptyStringAsNull", "conflictPolicy", "conflictKeyCount":
		return true
	default:
		return false
	}
}

func sanitizeReproductionBundleEvents(input []reproductionBundleEvent) []reproductionBundleEvent {
	result := make([]reproductionBundleEvent, 0, len(input))
	for _, event := range input {
		name := sanitizeReproductionBundleLabel(event.Name)
		if name == "" {
			continue
		}
		result = append(result, reproductionBundleEvent{
			OffsetMs: maxDiagnosticInt64(0, event.OffsetMs),
			Name:     name,
			Status:   sanitizeReproductionBundleLabel(event.Status),
			Stage:    sanitizeReproductionBundleLabel(event.Stage),
			Current:  maxDiagnosticInt64(0, event.Current),
			Total:    maxDiagnosticInt64(0, event.Total),
		})
	}
	if len(result) == 0 {
		result = append(result, reproductionBundleEvent{Name: "failure.observed"})
	}
	return result
}

func validateReproductionBundleEvents(events []reproductionBundleEvent) error {
	if len(events) == 0 || len(events) > 500 {
		return errors.New("invalid reproduction event sequence")
	}
	for _, event := range events {
		if sanitizeReproductionBundleLabel(event.Name) != event.Name ||
			sanitizeReproductionBundleLabel(event.Status) != event.Status ||
			sanitizeReproductionBundleLabel(event.Stage) != event.Stage ||
			event.OffsetMs < 0 || event.Current < 0 || event.Total < 0 {
			return errors.New("invalid reproduction event")
		}
	}
	return nil
}

func sanitizeReproductionBundleLabel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if len(value) > 160 || databaseDiagnosticHasSensitiveHint(strings.ToLower(value)) || !reproductionBundleLabelPattern.MatchString(value) {
		return ""
	}
	return value
}

func sanitizeReproductionBundleVersion(value string) string {
	value = strings.TrimSpace(normalizeVersion(value))
	if value == "" || sanitizeReproductionBundleLabel(value) == "" {
		return "0.0.0"
	}
	return value
}

func sanitizeReproductionBundleErrorKind(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || sanitizeReproductionBundleLabel(value) == "" {
		return "execution"
	}
	return value
}

func reproductionBundleFailureStatus(_ string) string {
	return "failed"
}

func reproductionBundleIdentifier(value string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(value)))
	return "source-" + hex.EncodeToString(digest[:8])
}

func reproductionBundleOffset(startedAt, eventAt int64) int64 {
	if startedAt <= 0 || eventAt <= startedAt {
		return 0
	}
	return eventAt - startedAt
}

func reproductionBundleSyncMappingSummary(mappings []syncjob.TableMapping) (int, int, string) {
	columnCount := 0
	transformSet := make(map[string]struct{})
	for _, mapping := range mappings {
		columnCount += len(mapping.Columns)
		for _, column := range mapping.Columns {
			if kind := sanitizeReproductionBundleLabel(column.Transform.Kind); kind != "" {
				transformSet[kind] = struct{}{}
			}
		}
	}
	transformKinds := make([]string, 0, len(transformSet))
	for kind := range transformSet {
		transformKinds = append(transformKinds, kind)
	}
	sort.Strings(transformKinds)
	return len(mappings), columnCount, strings.Join(transformKinds, ".")
}

func reproductionBundleDelimiterKind(delimiter string) string {
	switch delimiter {
	case "", ",":
		return "comma"
	case "\t":
		return "tab"
	case ";":
		return "semicolon"
	case "|":
		return "pipe"
	default:
		return "custom"
	}
}

func defaultReproductionBundleRedaction() reproductionBundleRedaction {
	return reproductionBundleRedaction{
		Credentials:      "excluded",
		DSN:              "excluded",
		SQLLiterals:      "removed",
		BusinessValues:   "excluded",
		SensitivePaths:   "excluded",
		RawErrorMessages: "classified_only",
	}
}

func validReproductionBundleSourceKind(kind reproductionBundleSourceKind) bool {
	switch kind {
	case reproductionBundleSourceQuery, reproductionBundleSourceSync, reproductionBundleSourceImport, reproductionBundleSourceMCP:
		return true
	default:
		return false
	}
}

func cloneReproductionBundleCapabilities(input map[string]string) map[string]string {
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func equalReproductionBundleCapabilities(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func equalReproductionBundleEvents(left, right []reproductionBundleEvent) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
