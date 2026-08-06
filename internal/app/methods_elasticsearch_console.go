package app

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/esconsole"
	"GoNavi-Wails/internal/logger"
	"github.com/google/uuid"
)

const (
	defaultElasticsearchConsoleConfirmationTokenTTL = 2 * time.Minute
	elasticsearchConsoleErrorDisplayLimit           = 64 << 10
	elasticsearchConsoleBatchResponseLimit          = 32 << 20
	elasticsearchConsoleBlockConnectionProtected    = "connection_protected"
)

type elasticsearchConsoleConfirmationToken struct {
	contextHash string
	expiresAt   time.Time
}

// ElasticsearchConsoleRequestInspection is the safe, body-free presentation
// of one parsed Elasticsearch Console request.
type ElasticsearchConsoleRequestInspection struct {
	Index          int    `json:"index"`
	Method         string `json:"method"`
	Path           string `json:"path"`
	Route          string `json:"route"`
	Target         string `json:"target,omitempty"`
	TargetSummary  string `json:"targetSummary,omitempty"`
	BodyKind       string `json:"bodyKind"`
	BodyBytes      int    `json:"bodyBytes"`
	BodySHA256     string `json:"bodySha256"`
	Category       string `json:"category"`
	Risk           string `json:"risk"`
	ContainsScript bool   `json:"containsScript,omitempty"`
	OperationCount int    `json:"operationCount,omitempty"`
	BlockReason    string `json:"blockReason,omitempty"`
}

// ElasticsearchConsoleInspection is returned before any request is sent.
type ElasticsearchConsoleInspection struct {
	Success              bool                                    `json:"success"`
	Message              string                                  `json:"message,omitempty"`
	Fingerprint          string                                  `json:"fingerprint,omitempty"`
	Requests             []ElasticsearchConsoleRequestInspection `json:"requests"`
	ContainsWrite        bool                                    `json:"containsWrite"`
	ContainsScript       bool                                    `json:"containsScript"`
	RequiresConfirmation bool                                    `json:"requiresConfirmation"`
	ConfirmationToken    string                                  `json:"confirmationToken,omitempty"`
	Blocked              bool                                    `json:"blocked"`
	BlockReason          string                                  `json:"blockReason,omitempty"`
	ServerMajor          int                                     `json:"serverMajor,omitempty"`
}

// ElasticsearchConsoleRequestResult preserves both the original response and
// an optional tabular projection used by the existing result tabs.
type ElasticsearchConsoleRequestResult struct {
	Index          int                      `json:"index"`
	Method         string                   `json:"method"`
	Path           string                   `json:"path"`
	RequestLabel   string                   `json:"requestLabel"`
	HTTPStatus     int                      `json:"httpStatus,omitempty"`
	DurationMs     int64                    `json:"durationMs"`
	RawResponse    string                   `json:"rawResponse,omitempty"`
	ContentType    string                   `json:"contentType,omitempty"`
	Rows           []map[string]interface{} `json:"rows,omitempty"`
	Columns        []string                 `json:"columns,omitempty"`
	AffectedRows   int64                    `json:"affectedRows,omitempty"`
	Outcome        string                   `json:"outcome"`
	Message        string                   `json:"message,omitempty"`
	PartialFailure bool                     `json:"partialFailure,omitempty"`
	OutcomeUnknown bool                     `json:"outcomeUnknown,omitempty"`
	ReadOnly       bool                     `json:"readOnly"`
	ServerMajor    int                      `json:"serverMajor,omitempty"`
	transportError bool
}

// ElasticsearchConsoleExecutionResult is an ordered, stop-on-first-failure
// batch response.
type ElasticsearchConsoleExecutionResult struct {
	Success        bool                                `json:"success"`
	Status         string                              `json:"status"`
	Message        string                              `json:"message,omitempty"`
	QueryID        string                              `json:"queryId"`
	Fingerprint    string                              `json:"fingerprint,omitempty"`
	Results        []ElasticsearchConsoleRequestResult `json:"results"`
	Completed      int                                 `json:"completed"`
	FailedIndex    int                                 `json:"failedIndex,omitempty"`
	OutcomeUnknown bool                                `json:"outcomeUnknown,omitempty"`
}

// InspectElasticsearchConsole parses and classifies a console batch without
// sending it. Dangerous, allowed batches receive a short-lived one-time token.
func (a *App) InspectElasticsearchConsole(config connection.ConnectionConfig, defaultIndex, source string) ElasticsearchConsoleInspection {
	serverMajor := a.cachedElasticsearchServerMajor(config)
	batch, err := esconsole.ParseSourceForMajor(source, defaultIndex, serverMajor)
	if err != nil {
		return ElasticsearchConsoleInspection{
			Success:  false,
			Message:  truncateElasticsearchConsoleError(err.Error()),
			Requests: []ElasticsearchConsoleRequestInspection{},
			Blocked:  true,
		}
	}
	inspection := a.inspectElasticsearchConsoleBatch(config, defaultIndex, batch, true)
	if !inspection.Success {
		return inspection
	}
	inspection.ServerMajor = serverMajor
	return inspection
}

func (a *App) cachedElasticsearchServerMajor(config connection.ConnectionConfig) int {
	effectiveConfig, err := a.resolveElasticsearchConsoleConnectionConfig(config)
	if err != nil {
		return 0
	}
	a.mu.RLock()
	entry, ok := a.dbCache[getCacheKey(effectiveConfig)]
	a.mu.RUnlock()
	if !ok || entry.inst == nil {
		return 0
	}
	provider, ok := entry.inst.(db.ElasticsearchServerVersionProvider)
	if !ok {
		return 0
	}
	return provider.ElasticsearchServerMajor()
}

func (a *App) inspectElasticsearchConsoleBatch(config connection.ConnectionConfig, defaultIndex string, batch esconsole.Batch, issueToken bool) ElasticsearchConsoleInspection {
	inspection := ElasticsearchConsoleInspection{
		Success:              !batch.Blocked,
		Fingerprint:          batch.Fingerprint,
		Requests:             make([]ElasticsearchConsoleRequestInspection, 0, len(batch.Requests)),
		ContainsWrite:        batch.ContainsWrite,
		ContainsScript:       batch.ContainsScript,
		RequiresConfirmation: batch.RequiresConfirmation,
		Blocked:              batch.Blocked,
	}
	for index, request := range batch.Requests {
		category := "read"
		if request.IsWrite {
			category = "write"
		}
		inspection.Requests = append(inspection.Requests, ElasticsearchConsoleRequestInspection{
			Index:          index,
			Method:         request.Method,
			Path:           request.Path,
			Route:          request.Route,
			Target:         request.Target,
			TargetSummary:  summarizeElasticsearchConsoleTarget(request.Target),
			BodyKind:       string(request.BodyKind),
			BodyBytes:      len(request.Body),
			BodySHA256:     request.BodySHA256,
			Category:       category,
			Risk:           string(request.Risk),
			ContainsScript: request.ContainsScript,
			OperationCount: request.OperationCount,
			BlockReason:    request.BlockReason,
		})
		if inspection.BlockReason == "" && request.BlockReason != "" {
			inspection.BlockReason = request.BlockReason
		}
	}

	effectiveConfig, err := a.resolveElasticsearchConsoleConnectionConfig(config)
	if err != nil {
		inspection.Success = false
		inspection.Blocked = true
		inspection.Message = truncateElasticsearchConsoleError(err.Error())
		return inspection
	}
	if resolveDDLDBType(effectiveConfig) != "elasticsearch" {
		inspection.Success = false
		inspection.Blocked = true
		inspection.BlockReason = "unsupported_connection"
		inspection.Message = "Elasticsearch Console requires an Elasticsearch connection"
		return inspection
	}
	if batch.Blocked {
		inspection.Success = false
		inspection.Message = "Elasticsearch endpoint is blocked by the console policy"
		return inspection
	}
	if (effectiveConfig.ReadOnly || effectiveConfig.Protection.RestrictScriptExecution) && (batch.ContainsWrite || batch.ContainsScript) {
		inspection.Success = false
		inspection.Blocked = true
		inspection.BlockReason = elasticsearchConsoleBlockConnectionProtected
		inspection.Message = readOnlyConnectionQueryBlockedMessage()
		return inspection
	}
	if issueToken && batch.RequiresConfirmation {
		token, err := a.issueElasticsearchConsoleConfirmationToken(effectiveConfig, defaultIndex, batch.Fingerprint)
		if err != nil {
			inspection.Success = false
			inspection.Blocked = true
			inspection.Message = truncateElasticsearchConsoleError(err.Error())
			return inspection
		}
		inspection.ConfirmationToken = token
	}
	return inspection
}

// ExecuteElasticsearchConsole reparses the exact source, checks the caller's
// fingerprint and consumes a matching confirmation token before execution.
func (a *App) ExecuteElasticsearchConsole(config connection.ConnectionConfig, defaultIndex, source, queryID, fingerprint, confirmationToken string) ElasticsearchConsoleExecutionResult {
	result := ElasticsearchConsoleExecutionResult{
		Status:      "error",
		QueryID:     strings.TrimSpace(queryID),
		Results:     []ElasticsearchConsoleRequestResult{},
		FailedIndex: -1,
	}
	if result.QueryID == "" {
		result.QueryID = generateQueryID()
	}

	batch, err := esconsole.ParseSourceForMajor(source, defaultIndex, a.cachedElasticsearchServerMajor(config))
	if err != nil {
		result.Message = truncateElasticsearchConsoleError(err.Error())
		return result
	}
	result.Fingerprint = batch.Fingerprint
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(fingerprint)), []byte(batch.Fingerprint)) != 1 {
		result.Message = "Elasticsearch console fingerprint mismatch; inspect the current source again"
		return result
	}
	inspection := a.inspectElasticsearchConsoleBatch(config, defaultIndex, batch, false)
	if !inspection.Success {
		result.Message = inspection.Message
		return result
	}
	effectiveConfig, err := a.resolveElasticsearchConsoleConnectionConfig(config)
	if err != nil {
		result.Message = truncateElasticsearchConsoleError(err.Error())
		return result
	}
	if batch.RequiresConfirmation {
		if err := a.validateElasticsearchConsoleConfirmationToken(effectiveConfig, defaultIndex, batch.Fingerprint, confirmationToken); err != nil {
			result.Message = truncateElasticsearchConsoleError(err.Error())
			return result
		}
	}
	runConfig := normalizeRunConfig(effectiveConfig, "")
	database, err := a.getDatabase(runConfig)
	if err != nil {
		result.Message = truncateElasticsearchConsoleError(err.Error())
		return result
	}
	executor, supportsConsole := database.(db.ElasticsearchConsoleExecutor)
	if !supportsConsole {
		result.Message = "the Elasticsearch driver does not support REST console execution"
		return result
	}

	ctx, cancel := newQueryExecutionContext(runConfig)
	defer cancel()
	a.queryMu.Lock()
	if a.runningQueries == nil {
		a.runningQueries = make(map[string]queryContext)
	}
	if _, exists := a.runningQueries[result.QueryID]; exists {
		a.queryMu.Unlock()
		cancel()
		result.Message = "Elasticsearch console query ID is already running"
		return result
	}
	a.runningQueries[result.QueryID] = queryContext{cancel: cancel, started: time.Now(), retainUntilDone: true}
	a.queryMu.Unlock()
	defer func() {
		a.queryMu.Lock()
		delete(a.runningQueries, result.QueryID)
		a.queryMu.Unlock()
	}()
	if batch.RequiresConfirmation {
		if err := a.consumeElasticsearchConsoleConfirmationToken(effectiveConfig, defaultIndex, batch.Fingerprint, confirmationToken); err != nil {
			result.Message = truncateElasticsearchConsoleError(err.Error())
			return result
		}
	}

	responseBytes := 0
	for index, request := range batch.Requests {
		if err := ctx.Err(); err != nil {
			result.FailedIndex = index
			result.Message = fmt.Sprintf("Elasticsearch console batch canceled before request %d: %v", index+1, err)
			return result
		}
		if strings.TrimSpace(config.ID) != "" {
			currentConfig, err := a.resolveElasticsearchConsoleConnectionConfig(config)
			if err != nil {
				result.FailedIndex = index
				result.Message = truncateElasticsearchConsoleError(err.Error())
				return result
			}
			if getCacheKey(currentConfig) != getCacheKey(effectiveConfig) {
				result.FailedIndex = index
				result.Message = "Elasticsearch saved connection changed while the batch was running"
				return result
			}
			if (currentConfig.ReadOnly || currentConfig.Protection.RestrictScriptExecution) && (request.IsWrite || request.ContainsScript) {
				result.FailedIndex = index
				result.Message = readOnlyConnectionQueryBlockedMessage()
				return result
			}
		}
		requestResult := a.executeElasticsearchConsoleRequest(ctx, database, executor, request, index)
		responseBytes += len(requestResult.RawResponse)
		if responseBytes > elasticsearchConsoleBatchResponseLimit {
			requestResult.RawResponse = truncateElasticsearchConsoleError(requestResult.RawResponse)
			requestResult.Rows = nil
			requestResult.Columns = nil
			requestResult.Outcome = "error"
			requestResult.PartialFailure = false
			requestResult.OutcomeUnknown = request.IsWrite
			requestResult.Message = "Elasticsearch console batch responses exceed the 32 MiB limit"
		}
		result.Results = append(result.Results, requestResult)
		result.Completed = len(result.Results)
		if requestResult.transportError {
			if health, ok := database.(db.ElasticsearchConsoleTransportHealth); ok && !health.ElasticsearchConsoleTransportUsable() {
				a.invalidateCachedDatabase(runConfig, errors.New(requestResult.Message))
			}
		}
		if requestResult.Outcome == "success" {
			continue
		}
		result.FailedIndex = index
		result.Status = requestResult.Outcome
		result.Message = requestResult.Message
		result.OutcomeUnknown = requestResult.OutcomeUnknown
		return result
	}

	result.Success = true
	result.Status = "success"
	result.Message = "Elasticsearch console batch executed successfully"
	a.markCachedDatabaseHealthy(database, time.Now())
	return result
}

func (a *App) executeElasticsearchConsoleRequest(ctx context.Context, database db.Database, executor db.ElasticsearchConsoleExecutor, request esconsole.Request, index int) ElasticsearchConsoleRequestResult {
	startedAt := time.Now()
	result := ElasticsearchConsoleRequestResult{
		Index:        index,
		Method:       request.Method,
		Path:         request.Path,
		RequestLabel: buildElasticsearchConsoleRequestLabel(request),
		Outcome:      "error",
		ReadOnly:     true,
	}
	defer func() {
		result.DurationMs = time.Since(startedAt).Milliseconds()
	}()

	if request.IsWrite && request.Target != "" {
		probeResponse, transportFailure, validationErr := validateElasticsearchConsoleWriteTargets(ctx, executor, request)
		if validationErr != nil {
			result.HTTPStatus = probeResponse.StatusCode
			result.Message = truncateElasticsearchConsoleError(validationErr.Error())
			result.transportError = transportFailure
			a.logElasticsearchConsoleRequest(request, probeResponse.StatusCode, time.Since(startedAt).Milliseconds(), "target_validation_failed")
			return result
		}
	}

	wireRequest := db.ElasticsearchConsoleRequest{
		Method:   request.Method,
		Path:     request.Path,
		Body:     request.Body,
		BodyKind: db.ElasticsearchConsoleBodyKind(request.BodyKind),
	}
	response, err := executor.ExecuteElasticsearchConsoleRequest(ctx, wireRequest)
	result.DurationMs = time.Since(startedAt).Milliseconds()
	if err != nil {
		result.Message = truncateElasticsearchConsoleError(err.Error())
		result.OutcomeUnknown = request.IsWrite
		result.transportError = true
		a.logElasticsearchConsoleRequest(request, 0, result.DurationMs, "transport_error")
		return result
	}

	result.HTTPStatus = response.StatusCode
	result.ContentType = response.ContentType
	result.RawResponse = response.RawBody
	result.ServerMajor = response.ServerMajor
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		result.RawResponse = truncateElasticsearchConsoleError(result.RawResponse)
		result.Message = fmt.Sprintf("Elasticsearch returned HTTP %d", response.StatusCode)
		a.logElasticsearchConsoleRequest(request, response.StatusCode, result.DurationMs, "error")
		return result
	}
	if request.IsWrite {
		var payload map[string]interface{}
		if strings.TrimSpace(response.RawBody) == "" || json.Unmarshal([]byte(response.RawBody), &payload) != nil || payload == nil {
			result.RawResponse = truncateElasticsearchConsoleError(result.RawResponse)
			result.Message = "Elasticsearch returned an empty or invalid write response"
			result.OutcomeUnknown = true
			a.logElasticsearchConsoleRequest(request, response.StatusCode, result.DurationMs, "invalid_write_response")
			return result
		}
	}
	var incomplete bool
	result.Rows, result.Columns, result.AffectedRows, result.PartialFailure, incomplete = projectElasticsearchConsoleResponse(response.RawBody)
	result.OutcomeUnknown = request.IsWrite && incomplete
	if result.PartialFailure {
		result.Outcome = "partial"
		result.Message = "Elasticsearch response contains failed or incomplete operations"
		a.logElasticsearchConsoleRequest(request, response.StatusCode, result.DurationMs, "partial")
		return result
	}
	result.Outcome = "success"
	a.logElasticsearchConsoleRequest(request, response.StatusCode, result.DurationMs, "success")
	return result
}

func validateElasticsearchConsoleWriteTargets(ctx context.Context, executor db.ElasticsearchConsoleExecutor, request esconsole.Request) (db.ElasticsearchConsoleResponse, bool, error) {
	allowMissing := request.Method == "PUT" && request.Route == "/{target}"
	for _, rawTarget := range strings.Split(request.Target, ",") {
		target := strings.TrimSpace(rawTarget)
		escapedTarget := strings.ReplaceAll(url.PathEscape(target), "+", "%2B")
		probe := db.ElasticsearchConsoleRequest{
			Method:   "GET",
			Path:     "/" + escapedTarget + "?filter_path=*.settings.index.uuid,*.settings.index.default_pipeline,*.settings.index.final_pipeline",
			BodyKind: db.ElasticsearchConsoleBodyKindNone,
		}
		response, err := executor.ExecuteElasticsearchConsoleRequest(ctx, probe)
		if err != nil {
			return response, true, fmt.Errorf("unable to verify the Elasticsearch write target: %w", err)
		}
		if response.StatusCode == 404 && allowMissing {
			continue
		}
		if response.StatusCode == 401 || response.StatusCode == 403 {
			return response, false, errors.New("Elasticsearch console writes require view_index_metadata (or manage) permission to verify concrete index targets")
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return response, false, errors.New("Elasticsearch writes require an existing concrete non-system target")
		}
		var indices map[string]struct {
			Settings struct {
				Index struct {
					UUID            string `json:"uuid"`
					DefaultPipeline string `json:"default_pipeline"`
					FinalPipeline   string `json:"final_pipeline"`
				} `json:"index"`
			} `json:"settings"`
		}
		if err := json.Unmarshal([]byte(response.RawBody), &indices); err != nil || len(indices) == 0 {
			return response, false, errors.New("Elasticsearch returned an invalid response while verifying the write target")
		}
		for concrete, metadata := range indices {
			if strings.HasPrefix(concrete, ".") || strings.TrimSpace(metadata.Settings.Index.UUID) == "" {
				return response, false, errors.New("Elasticsearch writes cannot resolve to a system or unverifiable index")
			}
			if request.MayRunIngestPipeline && elasticsearchConsoleTargetMayIngest(request, target) {
				for _, pipeline := range []string{metadata.Settings.Index.DefaultPipeline, metadata.Settings.Index.FinalPipeline} {
					pipeline = strings.TrimSpace(pipeline)
					if pipeline != "" && pipeline != "_none" {
						return response, false, errors.New("Elasticsearch console writes require indices without configured ingest pipelines")
					}
				}
			}
		}
		if _, exact := indices[target]; !exact || len(indices) != 1 {
			return response, false, errors.New("Elasticsearch console writes cannot target an alias or data stream")
		}
	}
	return db.ElasticsearchConsoleResponse{}, false, nil
}

func elasticsearchConsoleTargetMayIngest(request esconsole.Request, target string) bool {
	if len(request.IngestTargets) == 0 {
		return true
	}
	for _, ingestTarget := range request.IngestTargets {
		if ingestTarget == target {
			return true
		}
	}
	return false
}

func buildElasticsearchConsoleRequestLabel(request esconsole.Request) string {
	path := request.Path
	if queryIndex := strings.IndexByte(path, '?'); queryIndex >= 0 {
		path = path[:queryIndex]
	}
	return strings.TrimSpace(request.Method + " " + path)
}

func projectElasticsearchConsoleResponse(raw string) (rows []map[string]interface{}, columns []string, affectedRows int64, partial bool, incomplete bool) {
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, nil, 0, false, false
	}
	if errorsFlag, ok := payload["errors"].(bool); ok && errorsFlag {
		partial = true
	}
	if timedOut, ok := payload["timed_out"].(bool); ok && timedOut {
		partial = true
		incomplete = true
	}
	if failures, ok := payload["failures"].([]interface{}); ok && len(failures) > 0 {
		partial = true
	}
	if conflicts, ok := jsonNumericInt64(payload["version_conflicts"]); ok && conflicts > 0 {
		partial = true
	}
	if elasticsearchShardFailures(payload["_shards"]) {
		partial = true
	}
	for _, key := range []string{"acknowledged", "shards_acknowledged"} {
		if acknowledged, ok := payload[key].(bool); ok && !acknowledged {
			partial = true
			incomplete = true
		}
	}
	if responses, ok := payload["responses"].([]interface{}); ok {
		for _, rawResponse := range responses {
			response, ok := rawResponse.(map[string]interface{})
			if !ok {
				continue
			}
			if _, hasError := response["error"]; hasError {
				partial = true
				break
			}
			if status, ok := jsonNumericInt64(response["status"]); ok && status >= 400 {
				partial = true
				break
			}
			if timedOut, ok := response["timed_out"].(bool); ok && timedOut {
				partial = true
				incomplete = true
			}
			if failures, ok := response["failures"].([]interface{}); ok && len(failures) > 0 {
				partial = true
			}
			if elasticsearchShardFailures(response["_shards"]) {
				partial = true
			}
		}
	}
	if hits, ok := payload["hits"].(map[string]interface{}); ok {
		if rawHits, ok := hits["hits"].([]interface{}); ok {
			rows, columns = projectElasticsearchHits(rawHits)
		}
	}
	if items, ok := payload["items"].([]interface{}); ok {
		for _, rawItem := range items {
			item, ok := rawItem.(map[string]interface{})
			if !ok {
				continue
			}
			for _, rawAction := range item {
				action, ok := rawAction.(map[string]interface{})
				if !ok {
					continue
				}
				status, ok := jsonNumericInt64(action["status"])
				if ok && status >= 200 && status < 300 && !strings.EqualFold(fmt.Sprint(action["result"]), "noop") {
					affectedRows++
				}
			}
		}
	}
	if rows == nil {
		if count, ok := payload["count"]; ok {
			rows = []map[string]interface{}{{"count": count}}
			columns = []string{"count"}
		}
	}
	for _, key := range []string{"updated", "deleted", "created"} {
		if value, ok := jsonNumericInt64(payload[key]); ok {
			affectedRows += value
		}
	}
	if affectedRows == 0 {
		if action, ok := payload["result"].(string); ok {
			switch strings.ToLower(strings.TrimSpace(action)) {
			case "created", "updated", "deleted":
				affectedRows = 1
			}
		}
	}
	return rows, columns, affectedRows, partial, incomplete
}

func elasticsearchShardFailures(value interface{}) bool {
	shards, ok := value.(map[string]interface{})
	if !ok {
		return false
	}
	failed, ok := jsonNumericInt64(shards["failed"])
	return ok && failed > 0
}

func projectElasticsearchHits(rawHits []interface{}) ([]map[string]interface{}, []string) {
	rows := make([]map[string]interface{}, 0, len(rawHits))
	columnSet := make(map[string]struct{})
	for _, rawHit := range rawHits {
		hit, ok := rawHit.(map[string]interface{})
		if !ok {
			continue
		}
		row := make(map[string]interface{})
		for _, key := range []string{"_index", "_id", "_score"} {
			if value, exists := hit[key]; exists {
				row[key] = value
				columnSet[key] = struct{}{}
			}
		}
		if source, ok := hit["_source"].(map[string]interface{}); ok {
			for key, value := range source {
				if _, metadataColumn := row[key]; metadataColumn {
					continue
				}
				row[key] = value
				columnSet[key] = struct{}{}
			}
		}
		rows = append(rows, row)
	}
	columns := make([]string, 0, len(columnSet))
	for _, key := range []string{"_index", "_id", "_score"} {
		if _, exists := columnSet[key]; exists {
			columns = append(columns, key)
			delete(columnSet, key)
		}
	}
	remaining := make([]string, 0, len(columnSet))
	for key := range columnSet {
		remaining = append(remaining, key)
	}
	sort.Strings(remaining)
	columns = append(columns, remaining...)
	return rows, columns
}

func jsonNumericInt64(value interface{}) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		return int64(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func truncateElasticsearchConsoleError(raw string) string {
	if len(raw) <= elasticsearchConsoleErrorDisplayLimit {
		return raw
	}
	const suffix = "\n… [truncated]"
	return raw[:elasticsearchConsoleErrorDisplayLimit-len(suffix)] + suffix
}

func summarizeElasticsearchConsoleTarget(target string) string {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return "cluster"
	}
	digest := sha256.Sum256([]byte(trimmed))
	return "sha256:" + hex.EncodeToString(digest[:6])
}

func (a *App) logElasticsearchConsoleRequest(request esconsole.Request, status int, durationMs int64, outcome string) {
	logger.Infof(
		"Elasticsearch Console：method=%s route=%s target=%s bodyBytes=%d bodySHA256=%s status=%d outcome=%s durationMs=%d",
		request.Method,
		request.Route,
		summarizeElasticsearchConsoleTarget(request.Target),
		len(request.Body),
		request.BodySHA256,
		status,
		outcome,
		durationMs,
	)
}

func (a *App) issueElasticsearchConsoleConfirmationToken(config connection.ConnectionConfig, defaultIndex, fingerprint string) (string, error) {
	contextHash, err := a.buildElasticsearchConsoleConfirmationContextHash(config, defaultIndex, fingerprint)
	if err != nil {
		return "", err
	}
	ttl := a.elasticsearchConsoleTokenTTL
	if ttl <= 0 {
		ttl = defaultElasticsearchConsoleConfirmationTokenTTL
	}
	now := time.Now()
	token := uuid.NewString()
	a.elasticsearchConsoleTokenMu.Lock()
	defer a.elasticsearchConsoleTokenMu.Unlock()
	if a.elasticsearchConsoleTokens == nil {
		a.elasticsearchConsoleTokens = make(map[string]elasticsearchConsoleConfirmationToken)
	}
	a.pruneExpiredElasticsearchConsoleTokensLocked(now)
	a.elasticsearchConsoleTokens[token] = elasticsearchConsoleConfirmationToken{
		contextHash: contextHash,
		expiresAt:   now.Add(ttl),
	}
	return token, nil
}

func (a *App) consumeElasticsearchConsoleConfirmationToken(config connection.ConnectionConfig, defaultIndex, fingerprint, token string) error {
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return errors.New("Elasticsearch console confirmation token is required")
	}
	expectedHash, err := a.buildElasticsearchConsoleConfirmationContextHash(config, defaultIndex, fingerprint)
	if err != nil {
		return err
	}
	now := time.Now()
	a.elasticsearchConsoleTokenMu.Lock()
	if a.elasticsearchConsoleTokens == nil {
		a.elasticsearchConsoleTokens = make(map[string]elasticsearchConsoleConfirmationToken)
	}
	entry, ok := a.elasticsearchConsoleTokens[trimmedToken]
	if ok {
		delete(a.elasticsearchConsoleTokens, trimmedToken)
	}
	a.pruneExpiredElasticsearchConsoleTokensLocked(now)
	a.elasticsearchConsoleTokenMu.Unlock()
	if !ok {
		return errors.New("Elasticsearch console confirmation token is invalid or was already used")
	}
	if !entry.expiresAt.After(now) {
		return errors.New("Elasticsearch console confirmation token has expired")
	}
	if subtle.ConstantTimeCompare([]byte(entry.contextHash), []byte(expectedHash)) != 1 {
		return errors.New("Elasticsearch console confirmation token does not match the current request")
	}
	return nil
}

func (a *App) validateElasticsearchConsoleConfirmationToken(config connection.ConnectionConfig, defaultIndex, fingerprint, token string) error {
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return errors.New("Elasticsearch console confirmation token is required")
	}
	expectedHash, err := a.buildElasticsearchConsoleConfirmationContextHash(config, defaultIndex, fingerprint)
	if err != nil {
		return err
	}
	now := time.Now()
	a.elasticsearchConsoleTokenMu.Lock()
	entry, ok := a.elasticsearchConsoleTokens[trimmedToken]
	a.elasticsearchConsoleTokenMu.Unlock()
	if !ok {
		return errors.New("Elasticsearch console confirmation token is invalid or was already used")
	}
	if !entry.expiresAt.After(now) {
		return errors.New("Elasticsearch console confirmation token has expired")
	}
	if subtle.ConstantTimeCompare([]byte(entry.contextHash), []byte(expectedHash)) != 1 {
		return errors.New("Elasticsearch console confirmation token does not match the current request")
	}
	return nil
}

func (a *App) pruneExpiredElasticsearchConsoleTokensLocked(now time.Time) {
	for token, entry := range a.elasticsearchConsoleTokens {
		if !entry.expiresAt.After(now) {
			delete(a.elasticsearchConsoleTokens, token)
		}
	}
}

func (a *App) buildElasticsearchConsoleConfirmationContextHash(config connection.ConnectionConfig, defaultIndex, fingerprint string) (string, error) {
	effectiveConfig, err := a.resolveElasticsearchConsoleConnectionConfig(config)
	if err != nil {
		return "", err
	}
	return hashJSONValue(struct {
		ConnectionID          string `json:"connectionId"`
		ConnectionFingerprint string `json:"connectionFingerprint"`
		DefaultIndex          string `json:"defaultIndex"`
		BatchFingerprint      string `json:"batchFingerprint"`
		ReadOnly              bool   `json:"readOnly"`
		RestrictScript        bool   `json:"restrictScript"`
	}{
		ConnectionID:          strings.TrimSpace(config.ID),
		ConnectionFingerprint: getCacheKey(effectiveConfig),
		DefaultIndex:          strings.TrimSpace(defaultIndex),
		BatchFingerprint:      strings.TrimSpace(fingerprint),
		ReadOnly:              effectiveConfig.ReadOnly,
		RestrictScript:        effectiveConfig.Protection.RestrictScriptExecution,
	})
}

func (a *App) resolveElasticsearchConsoleConnectionConfig(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
	merged := config
	if strings.TrimSpace(config.ID) != "" {
		repo := newSavedConnectionRepository(a.configDir, a.secretStore)
		if view, err := repo.Find(config.ID); err == nil {
			merged = view.Config
			merged.ID = view.ID
			merged.ReadOnly = config.ReadOnly || view.Config.ReadOnly
			merged.Protection.RestrictScriptExecution = config.Protection.RestrictScriptExecution || view.Config.Protection.RestrictScriptExecution
			if config.HasRuntimeDatabaseOverride() {
				merged = merged.WithRuntimeDatabaseOverride(config.RuntimeDatabaseOverride())
			}
		}
	}
	return a.resolveEffectiveConnectionConfig(merged)
}
