package esconsole

import (
	"bytes"
	"encoding/json"
	"net/url"
	"sort"
	"strings"
)

var privilegedRootEndpoints = map[string]struct{}{
	"_security":           {},
	"_snapshot":           {},
	"_nodes":              {},
	"_reindex":            {},
	"_scripts":            {},
	"_template":           {},
	"_index_template":     {},
	"_component_template": {},
	"_ingest":             {},
	"_ilm":                {},
	"_slm":                {},
	"_license":            {},
	"_watcher":            {},
	"_ml":                 {},
	"_ccr":                {},
	"_remote":             {},
	"_remote_cluster":     {},
}

func prepareBatch(batch *Batch, serverMajor int) error {
	for i := range batch.Requests {
		if err := classifyRequest(&batch.Requests[i], serverMajor); err != nil {
			if parseErr, ok := err.(*ParseError); ok {
				parseErr.RequestIndex = i
			}
			return err
		}
		if err := normalizeRequestBody(&batch.Requests[i]); err != nil {
			if parseErr, ok := err.(*ParseError); ok {
				parseErr.RequestIndex = i
			}
			return err
		}
		if batch.Requests[i].ContainsScript && batch.Requests[i].Risk != RiskBlocked {
			batch.Requests[i].Risk = RiskDangerous
		}
	}
	return nil
}

func normalizeRequestBody(req *Request) error {
	if req.Risk == RiskBlocked {
		return nil
	}
	rawBody := req.Body
	body := strings.TrimSpace(rawBody)
	if body == "" {
		if isNDJSONRoute(req.Route) {
			return parseError(CodeInvalidNDJSON, "Elasticsearch NDJSON body is required", nil)
		}
		if requestBodyRequired(req) {
			return parseError(CodeBodyRequired, "Elasticsearch request body is required for this operation", nil)
		}
		req.Body = ""
		req.BodyKind = BodyNone
		return nil
	}
	if isNDJSONRoute(req.Route) {
		if req.Route == "/_msearch" || req.Route == "/{target}/_msearch" {
			return normalizeMultiSearchBody(req, rawBody)
		}
		return normalizeBulkBody(req, rawBody)
	}

	var object map[string]any
	if err := json.Unmarshal([]byte(body), &object); err != nil || object == nil {
		return parseError(CodeInvalidJSON, "Elasticsearch request body must be one JSON object", err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, []byte(body)); err != nil {
		return parseError(CodeInvalidJSON, "Elasticsearch request body is invalid JSON", err)
	}
	req.Body = compact.String()
	req.BodyKind = BodyJSON
	detectExecutableScript(req, object)
	if req.Route == "/_aliases" {
		if err := validateAliasActions(req, object); err != nil {
			return err
		}
	}
	return nil
}

func validateAliasActions(req *Request, object map[string]any) error {
	rawActions, exists := object["actions"]
	if !exists {
		return parseError(CodeInvalidAliasAction, "Elasticsearch aliases body requires an actions array", nil)
	}
	actions, ok := rawActions.([]any)
	if !ok {
		return parseError(CodeInvalidAliasAction, "Elasticsearch aliases actions must be an array", nil)
	}
	targetSet := make(map[string]struct{})
	removeIndexActions := 0
	for _, rawAction := range actions {
		actionObject, ok := rawAction.(map[string]any)
		if !ok || len(actionObject) != 1 {
			return parseError(CodeInvalidAliasAction, "Elasticsearch alias action must contain exactly one operation", nil)
		}
		var operation string
		var descriptorValue any
		for key, value := range actionObject {
			operation = strings.ToLower(key)
			descriptorValue = value
		}
		if operation != "add" && operation != "remove" && operation != "remove_index" {
			return parseError(CodeInvalidAliasAction, "Elasticsearch alias action is not allowed", nil)
		}
		descriptor, ok := descriptorValue.(map[string]any)
		if !ok {
			return parseError(CodeInvalidAliasAction, "Elasticsearch alias action descriptor must be an object", nil)
		}
		targets, err := aliasActionTargets(descriptor)
		if err != nil {
			return err
		}
		for _, target := range targets {
			if _, exists := targetSet[target]; !exists && len(targetSet) >= MaxWriteTargets {
				return parseError(CodeTooManyWriteTargets, "Elasticsearch request exceeds 100 unique write targets", nil)
			}
			targetSet[target] = struct{}{}
			if systemIndexTarget(target) {
				blockRequest(req, "system_index_write")
				continue
			}
			if !explicitIndexTarget(target) {
				blockRequest(req, "write_target_not_allowed")
				continue
			}
			if operation == "remove_index" && (len(targets) != 1 || unsafeDeleteTarget(target)) {
				blockRequest(req, "unsafe_index_delete")
			}
		}
		if operation == "remove_index" {
			removeIndexActions++
		}
	}
	if removeIndexActions > 1 {
		blockRequest(req, "unsafe_index_delete")
	}
	if req.Risk != RiskBlocked {
		req.Target = joinSortedTargets(targetSet)
	}
	return nil
}

func aliasActionTargets(descriptor map[string]any) ([]string, error) {
	var targets []string
	if rawIndex, exists := descriptor["index"]; exists {
		indexName, ok := rawIndex.(string)
		if !ok || strings.TrimSpace(indexName) == "" {
			return nil, parseError(CodeInvalidAliasAction, "Elasticsearch alias index must be a non-empty string", nil)
		}
		targets = append(targets, strings.TrimSpace(indexName))
	}
	if rawIndices, exists := descriptor["indices"]; exists {
		indices, ok := rawIndices.([]any)
		if !ok {
			return nil, parseError(CodeInvalidAliasAction, "Elasticsearch alias indices must be an array", nil)
		}
		for _, rawIndex := range indices {
			indexName, ok := rawIndex.(string)
			if !ok || strings.TrimSpace(indexName) == "" {
				return nil, parseError(CodeInvalidAliasAction, "Elasticsearch alias index must be a non-empty string", nil)
			}
			targets = append(targets, strings.TrimSpace(indexName))
		}
	}
	if len(targets) == 0 {
		return nil, parseError(CodeInvalidAliasAction, "Elasticsearch alias action requires index or indices", nil)
	}
	return targets, nil
}

func normalizeBulkBody(req *Request, body string) error {
	actionCount := 0
	targetSet := make(map[string]struct{})
	ingestTargetSet := make(map[string]struct{})
	pendingSourceAction := ""
	nonEmptyLines := 0
	routeTarget := req.Target
	containsPipeline := false
	normalized, err := transformNDJSONLines(body, func(lineIndex int, object map[string]any) error {
		nonEmptyLines++
		if pendingSourceAction != "" {
			if pendingSourceAction == "update" {
				if _, hasScript := object["script"]; hasScript {
					req.ContainsScript = true
				}
			}
			pendingSourceAction = ""
			return nil
		}

		actionLine := object
		if len(actionLine) != 1 {
			return ndjsonErrorAt(lineIndex, "Elasticsearch Bulk action line must contain exactly one action")
		}
		var action string
		var metadataValue any
		for key, value := range actionLine {
			action = strings.ToLower(key)
			metadataValue = value
		}
		if !allowedBulkAction(action) {
			return ndjsonErrorAt(lineIndex, "Elasticsearch Bulk action is not allowed")
		}
		metadata, ok := metadataValue.(map[string]any)
		if !ok || metadata == nil {
			return ndjsonErrorAt(lineIndex, "Elasticsearch Bulk action metadata must be a JSON object")
		}
		if _, exists := metadata["pipeline"]; exists {
			containsPipeline = true
		}
		effectiveTarget := routeTarget
		if rawIndex, exists := metadata["_index"]; exists {
			indexName, ok := rawIndex.(string)
			if !ok || strings.TrimSpace(indexName) == "" {
				return ndjsonErrorAt(lineIndex, "Elasticsearch Bulk _index must be a non-empty string")
			}
			effectiveTarget = strings.TrimSpace(indexName)
		}
		if effectiveTarget == "" {
			return ndjsonErrorAt(lineIndex, "Elasticsearch Bulk action requires an explicit index")
		}
		if _, exists := targetSet[effectiveTarget]; !exists && len(targetSet) >= MaxWriteTargets {
			return parseError(CodeTooManyWriteTargets, "Elasticsearch Bulk exceeds 100 unique write targets", nil)
		}
		targetSet[effectiveTarget] = struct{}{}
		if action == "index" || action == "create" {
			req.MayRunIngestPipeline = true
			ingestTargetSet[effectiveTarget] = struct{}{}
		}
		if strings.Contains(effectiveTarget, ":") {
			if req.Risk != RiskBlocked {
				blockRequest(req, "remote_cluster")
			}
		} else if systemIndexTarget(effectiveTarget) {
			if req.Risk != RiskBlocked {
				blockRequest(req, "system_index_write")
			}
		} else if !explicitIndexTarget(effectiveTarget) {
			if req.Risk != RiskBlocked {
				blockRequest(req, "bulk_target_not_allowed")
			}
		}

		actionCount++
		if actionCount > MaxBulkActions {
			return parseError(CodeTooManyBulkActions, "Elasticsearch Bulk body exceeds 10000 actions", nil)
		}
		if action != "delete" {
			pendingSourceAction = action
		}
		return nil
	})
	if err != nil {
		return err
	}
	if nonEmptyLines == 0 {
		return parseError(CodeInvalidNDJSON, "Elasticsearch Bulk body must contain at least one action", nil)
	}
	if pendingSourceAction != "" {
		return ndjsonErrorAt(nonEmptyLines, "Elasticsearch Bulk action is missing its source line")
	}

	req.Body = normalized
	req.BodyKind = BodyNDJSON
	req.OperationCount = actionCount
	if containsPipeline && req.Risk != RiskBlocked {
		blockRequest(req, "pipeline_not_allowed")
	}
	if req.Risk != RiskBlocked {
		req.Target = joinSortedTargets(targetSet)
		req.IngestTargets = sortedTargetSet(ingestTargetSet)
	}
	return nil
}

func sortedTargetSet(targets map[string]struct{}) []string {
	result := make([]string, 0, len(targets))
	for target := range targets {
		result = append(result, target)
	}
	sort.Strings(result)
	return result
}

func allowedBulkAction(action string) bool {
	switch action {
	case "index", "create", "update", "delete":
		return true
	default:
		return false
	}
}

func ndjsonErrorAt(line int, message string) *ParseError {
	err := parseError(CodeInvalidNDJSON, message, nil)
	err.Line = line
	return err
}

func normalizeMultiSearchBody(req *Request, body string) error {
	nonEmptyLines := 0
	operationCount := 0
	normalized, err := transformNDJSONLines(body, func(_ int, object map[string]any) error {
		nonEmptyLines++
		if nonEmptyLines%2 == 1 {
			if msearchHeaderUsesRemoteCluster(object) {
				blockRequest(req, "remote_cluster")
			}
			return nil
		}
		operationCount++
		if operationCount > MaxRequests {
			return parseError(CodeTooManyRequests, "Elasticsearch multi-search exceeds 100 requests", nil)
		}
		if containsExecutableSearchNode(object) {
			req.ContainsScript = true
		}
		return nil
	})
	if err != nil {
		return err
	}
	if nonEmptyLines == 0 || nonEmptyLines%2 != 0 {
		return parseError(CodeInvalidNDJSON, "Elasticsearch multi-search body must contain header/body pairs", nil)
	}
	req.Body = normalized
	req.BodyKind = BodyNDJSON
	req.OperationCount = operationCount
	return nil
}

func msearchHeaderUsesRemoteCluster(header map[string]any) bool {
	value, exists := header["index"]
	if !exists {
		return false
	}
	switch typed := value.(type) {
	case string:
		return strings.Contains(typed, ":")
	case []any:
		for _, item := range typed {
			if index, ok := item.(string); ok && strings.Contains(index, ":") {
				return true
			}
		}
	}
	return false
}

func transformNDJSONLines(body string, visit func(line int, object map[string]any) error) (string, error) {
	var normalized strings.Builder
	lineIndex := 0
	for remaining := body; ; lineIndex++ {
		line := remaining
		if newline := strings.IndexByte(remaining, '\n'); newline >= 0 {
			line = remaining[:newline]
			remaining = remaining[newline+1:]
		} else {
			remaining = ""
		}
		if len(line) > MaxNDJSONLineBytes {
			err := parseError(CodeNDJSONLineTooLarge, "Elasticsearch NDJSON line exceeds 8 MiB", nil)
			err.Line = lineIndex + 1
			return "", err
		}
		line = strings.TrimSpace(line)
		if line != "" {
			var object map[string]any
			decoder := json.NewDecoder(strings.NewReader(line))
			decoder.UseNumber()
			if err := decoder.Decode(&object); err != nil || object == nil {
				parseErr := parseError(CodeInvalidNDJSON, "Elasticsearch NDJSON line must be one JSON object", err)
				parseErr.Line = lineIndex + 1
				return "", parseErr
			}
			var compact bytes.Buffer
			if err := json.Compact(&compact, []byte(line)); err != nil {
				parseErr := parseError(CodeInvalidNDJSON, "Elasticsearch NDJSON line is invalid JSON", err)
				parseErr.Line = lineIndex + 1
				return "", parseErr
			}
			if err := visit(lineIndex+1, object); err != nil {
				return "", err
			}
			normalized.WriteString(compact.String())
			normalized.WriteByte('\n')
		}
		if remaining == "" {
			break
		}
	}
	return normalized.String(), nil
}

func detectExecutableScript(req *Request, object map[string]any) {
	if object == nil {
		return
	}
	switch req.Route {
	case "/{target}/_update/{id}", "/{target}/{type}/{id}/_update", "/{target}/_update_by_query":
		_, req.ContainsScript = object["script"]
	default:
		if req.Risk == RiskRead {
			req.ContainsScript = containsExecutableSearchNode(object)
		}
	}
	if req.ContainsScript && req.Risk == RiskNormalWrite {
		req.Risk = RiskDangerous
	}
}

func containsExecutableSearchNode(value any) bool {
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			switch strings.ToLower(key) {
			case "script", "_script", "script_fields", "runtime_mappings", "script_score", "scripted_metric":
				return true
			}
			if containsExecutableSearchNode(child) {
				return true
			}
		}
	case []any:
		for _, child := range node {
			if containsExecutableSearchNode(child) {
				return true
			}
		}
	}
	return false
}

func isNDJSONRoute(route string) bool {
	return route == "/_bulk" || route == "/{target}/_bulk" || route == "/_msearch" || route == "/{target}/_msearch"
}

func requestBodyRequired(req *Request) bool {
	switch req.Route {
	case "/_mget", "/{target}/_mget", "/_mtermvectors", "/{target}/_mtermvectors",
		"/{target}/_termvectors", "/{target}/_explain/{id}":
		return true
	case "/_aliases",
		"/{target}/_doc", "/{target}/_doc/{id}", "/{target}/_create/{id}", "/{target}/_update/{id}",
		"/{target}/{type}", "/{target}/{type}/{id}", "/{target}/{type}/{id}/_update",
		"/{target}/_update_by_query", "/{target}/_delete_by_query",
		"/{target}/_mapping", "/{target}/_mapping/{type}", "/{target}/_settings":
		return req.Method == "POST" || req.Method == "PUT"
	default:
		return false
	}
}

func classifyRequest(req *Request, serverMajor int) error {
	_, decodedPath, err := normalizeRequestTarget(req.Path)
	if err != nil {
		return err
	}
	parsed, err := url.ParseRequestURI(req.Path)
	if err != nil {
		return parseError(CodeUnsafePath, "Elasticsearch request target is invalid", err)
	}
	segments := splitPath(decodedPath)
	req.IsWrite = req.Method == "POST" || req.Method == "PUT" || req.Method == "DELETE"
	req.Risk = RiskBlocked
	req.BlockReason = "endpoint_not_allowed"
	req.Route = ""
	req.Target = ""

	if len(segments) > 0 {
		if _, blocked := privilegedRootEndpoints[segments[0]]; blocked {
			blockRequest(req, "privileged_endpoint")
			return nil
		}
		if segments[0] == "_cluster" && len(segments) > 1 && segments[1] == "settings" {
			blockRequest(req, "privileged_endpoint")
			return nil
		}
	}

	method := req.Method
	if len(segments) == 0 {
		if method == "GET" || method == "HEAD" {
			allowRequest(req, RiskRead, "/", "")
		}
		return nil
	}

	if method == "DELETE" && len(segments) == 1 && unsafeDeleteTarget(segments[0]) {
		req.IsWrite = true
		blockRequest(req, "unsafe_index_delete")
		return nil
	}

	if classifyRootEndpoint(req, segments) || classifyTargetEndpoint(req, segments, serverMajor) {
		if strings.Contains(req.Target, ":") {
			blockRequest(req, "remote_cluster")
			return nil
		}
		if (req.Risk == RiskNormalWrite || req.Risk == RiskDangerous) && systemIndexTarget(req.Target) {
			blockRequest(req, "system_index_write")
			return nil
		}
		if req.Risk == RiskNormalWrite && !explicitIndexTarget(req.Target) {
			blockRequest(req, "write_target_not_allowed")
			return nil
		}
		if req.Risk == RiskDangerous && req.Method == "PUT" && req.Route == "/{target}" && !explicitIndexTarget(req.Target) {
			blockRequest(req, "index_target_not_allowed")
			return nil
		}
		if method == "DELETE" && req.Target != "" && unsafeDeleteTarget(req.Target) {
			blockRequest(req, "unsafe_index_delete")
			return nil
		}
		if req.Route == "/{target}/_update_by_query" || req.Route == "/{target}/_delete_by_query" {
			waitValues, present := parsed.Query()["wait_for_completion"]
			if len(waitValues) > 1 || (present && len(waitValues) == 1 && strings.EqualFold(waitValues[0], "false")) {
				blockRequest(req, "async_by_query")
			}
		}
		if req.Risk == RiskDangerous && req.Target != "" {
			if req.Route == "/{target}/_update_by_query" || req.Route == "/{target}/_delete_by_query" {
				if !explicitMultiIndexTarget(req.Target) {
					blockRequest(req, "write_target_not_allowed")
				}
			} else if !explicitIndexTarget(req.Target) {
				blockRequest(req, "write_target_not_allowed")
			}
		}
		if req.IsWrite || req.Route == "/_msearch" || req.Route == "/{target}/_msearch" {
			for key := range parsed.Query() {
				if strings.EqualFold(key, "filter_path") {
					blockRequest(req, "response_filter_not_allowed")
					break
				}
				if req.IsWrite && strings.EqualFold(key, "pipeline") {
					blockRequest(req, "pipeline_not_allowed")
					break
				}
			}
		}
	}
	return nil
}

func classifyRootEndpoint(req *Request, segments []string) bool {
	method := req.Method
	first := segments[0]

	switch first {
	case "_search", "_count", "_mget", "_mtermvectors", "_field_caps":
		if len(segments) == 1 && (method == "GET" || method == "POST") {
			allowRequest(req, RiskRead, "/"+first, "")
			return true
		}
	case "_msearch":
		if len(segments) == 1 && (method == "GET" || method == "POST") {
			allowRequest(req, RiskRead, "/_msearch", "")
			return true
		}
	case "_mapping":
		if len(segments) == 3 && segments[1] == "field" && (method == "GET" || method == "HEAD") {
			allowRequest(req, RiskRead, "/_mapping/field/{fields}", "")
			return true
		}
		if len(segments) == 1 && (method == "GET" || method == "HEAD") {
			allowRequest(req, RiskRead, "/_mapping", "")
			return true
		}
	case "_settings":
		if len(segments) == 1 && (method == "GET" || method == "HEAD") {
			allowRequest(req, RiskRead, "/_settings", "")
			return true
		}
	case "_validate":
		if len(segments) == 2 && segments[1] == "query" && (method == "GET" || method == "POST") {
			allowRequest(req, RiskRead, "/_validate/query", "")
			return true
		}
	case "_alias":
		if (len(segments) == 1 || len(segments) == 2) && (method == "GET" || method == "HEAD") {
			route := "/_alias"
			if len(segments) == 2 {
				route += "/{name}"
			}
			allowRequest(req, RiskRead, route, "")
			return true
		}
	case "_stats":
		if (len(segments) == 1 || len(segments) == 2) && method == "GET" {
			route := "/_stats"
			if len(segments) == 2 {
				route += "/{metric}"
			}
			allowRequest(req, RiskRead, route, "")
			return true
		}
	case "_resolve":
		if len(segments) == 3 && segments[1] == "index" && method == "GET" {
			allowRequest(req, RiskRead, "/_resolve/index/{name}", segments[2])
			return true
		}
	case "_cluster":
		if (len(segments) == 2 || len(segments) == 3) && segments[1] == "health" && method == "GET" {
			route := "/_cluster/health"
			target := ""
			if len(segments) == 3 {
				route += "/{target}"
				target = segments[2]
			}
			allowRequest(req, RiskRead, route, target)
			return true
		}
	case "_cat":
		if (len(segments) == 2 || len(segments) == 3) && method == "GET" && allowedCATEndpoint(segments[1]) {
			route := "/_cat/" + segments[1]
			target := ""
			if len(segments) == 3 {
				route += "/{target}"
				target = segments[2]
			}
			allowRequest(req, RiskRead, route, target)
			return true
		}
	case "_bulk":
		if len(segments) == 1 && (method == "POST" || method == "PUT") {
			allowRequest(req, RiskDangerous, "/_bulk", "")
			return true
		}
	case "_aliases":
		if len(segments) == 1 && method == "POST" {
			allowRequest(req, RiskDangerous, "/_aliases", "")
			return true
		}
	}
	return strings.HasPrefix(first, "_")
}

func classifyTargetEndpoint(req *Request, segments []string, serverMajor int) bool {
	method := req.Method
	target := segments[0]
	if strings.HasPrefix(target, "_") {
		return false
	}

	if len(segments) == 1 {
		switch method {
		case "GET", "HEAD":
			allowRequest(req, RiskRead, "/{target}", target)
		case "PUT":
			allowRequest(req, RiskDangerous, "/{target}", target)
		case "DELETE":
			if unsafeDeleteTarget(target) {
				blockRequest(req, "unsafe_index_delete")
			} else {
				allowRequest(req, RiskDangerous, "/{target}", target)
			}
		default:
			return false
		}
		return true
	}

	endpoint := segments[1]
	switch endpoint {
	case "_search", "_count", "_mget", "_field_caps":
		if len(segments) == 2 && (method == "GET" || method == "POST") {
			allowRequest(req, RiskRead, "/{target}/"+endpoint, target)
			return true
		}
	case "_msearch":
		if len(segments) == 2 && (method == "GET" || method == "POST") {
			allowRequest(req, RiskRead, "/{target}/_msearch", target)
			return true
		}
	case "_validate":
		if len(segments) == 3 && segments[2] == "query" && (method == "GET" || method == "POST") {
			allowRequest(req, RiskRead, "/{target}/_validate/query", target)
			return true
		}
	case "_explain":
		if len(segments) == 3 && (method == "GET" || method == "POST") {
			allowRequest(req, RiskRead, "/{target}/_explain/{id}", target)
			return true
		}
	case "_termvectors":
		if (len(segments) == 2 || len(segments) == 3) && (method == "GET" || method == "POST") {
			route := "/{target}/_termvectors"
			if len(segments) == 3 {
				route += "/{id}"
			}
			allowRequest(req, RiskRead, route, target)
			return true
		}
	case "_mtermvectors":
		if len(segments) == 2 && (method == "GET" || method == "POST") {
			allowRequest(req, RiskRead, "/{target}/_mtermvectors", target)
			return true
		}
	case "_mapping":
		return classifyMapping(req, segments, target)
	case "_settings":
		return classifySettings(req, segments, target)
	case "_alias":
		if (len(segments) == 2 || len(segments) == 3) && (method == "GET" || method == "HEAD") {
			route := "/{target}/_alias"
			if len(segments) == 3 {
				route += "/{name}"
			}
			allowRequest(req, RiskRead, route, target)
			return true
		}
		if len(segments) == 3 && (method == "PUT" || method == "POST" || method == "DELETE") {
			allowRequest(req, RiskDangerous, "/{target}/_alias/{name}", target)
			return true
		}
	case "_stats":
		if (len(segments) == 2 || len(segments) == 3) && method == "GET" {
			route := "/{target}/_stats"
			if len(segments) == 3 {
				route += "/{metric}"
			}
			allowRequest(req, RiskRead, route, target)
			return true
		}
	case "_doc":
		if len(segments) == 2 && method == "POST" {
			allowRequest(req, RiskNormalWrite, "/{target}/_doc", target)
			return true
		}
		if len(segments) == 3 {
			switch method {
			case "GET", "HEAD":
				allowRequest(req, RiskRead, "/{target}/_doc/{id}", target)
			case "POST", "PUT":
				allowRequest(req, RiskNormalWrite, "/{target}/_doc/{id}", target)
			case "DELETE":
				allowRequest(req, RiskDangerous, "/{target}/_doc/{id}", target)
			default:
				return false
			}
			return true
		}
	case "_source":
		if len(segments) == 3 && (method == "GET" || method == "HEAD") {
			allowRequest(req, RiskRead, "/{target}/_source/{id}", target)
			return true
		}
	case "_create":
		if len(segments) == 3 && (method == "POST" || method == "PUT") {
			allowRequest(req, RiskNormalWrite, "/{target}/_create/{id}", target)
			return true
		}
	case "_update":
		if len(segments) == 3 && method == "POST" {
			allowRequest(req, RiskNormalWrite, "/{target}/_update/{id}", target)
			return true
		}
	case "_bulk":
		if len(segments) == 2 && (method == "POST" || method == "PUT") {
			allowRequest(req, RiskDangerous, "/{target}/_bulk", target)
			return true
		}
	case "_update_by_query", "_delete_by_query":
		if len(segments) == 2 && method == "POST" {
			allowRequest(req, RiskDangerous, "/{target}/"+endpoint, target)
			return true
		}
	case "_open", "_close", "_refresh":
		if len(segments) == 2 && method == "POST" {
			allowRequest(req, RiskDangerous, "/{target}/"+endpoint, target)
			return true
		}
	}

	// Elasticsearch 6 typed document and typed search/update forms.
	if serverMajor == 6 && len(segments) == 3 && segments[2] == "_search" && (method == "GET" || method == "POST") {
		allowRequest(req, RiskRead, "/{target}/{type}/_search", target)
		return true
	}
	if serverMajor == 6 && len(segments) == 2 && method == "POST" && !strings.HasPrefix(endpoint, "_") {
		allowRequest(req, RiskNormalWrite, "/{target}/{type}", target)
		return true
	}
	if serverMajor == 6 && len(segments) == 3 && !strings.HasPrefix(endpoint, "_") && !strings.HasPrefix(segments[2], "_") {
		switch method {
		case "GET", "HEAD":
			allowRequest(req, RiskRead, "/{target}/{type}/{id}", target)
		case "POST", "PUT":
			allowRequest(req, RiskNormalWrite, "/{target}/{type}/{id}", target)
		case "DELETE":
			allowRequest(req, RiskDangerous, "/{target}/{type}/{id}", target)
		default:
			return false
		}
		return true
	}
	if serverMajor == 6 && len(segments) == 4 && !strings.HasPrefix(endpoint, "_") && segments[3] == "_update" && method == "POST" {
		allowRequest(req, RiskNormalWrite, "/{target}/{type}/{id}/_update", target)
		return true
	}
	return false
}

func classifyMapping(req *Request, segments []string, target string) bool {
	method := req.Method
	if method == "GET" || method == "HEAD" {
		switch {
		case len(segments) == 2:
			allowRequest(req, RiskRead, "/{target}/_mapping", target)
			return true
		case len(segments) == 3:
			allowRequest(req, RiskRead, "/{target}/_mapping/{type}", target)
			return true
		case len(segments) == 4 && segments[2] == "field":
			allowRequest(req, RiskRead, "/{target}/_mapping/field/{fields}", target)
			return true
		}
	}
	if (method == "PUT" || method == "POST") && (len(segments) == 2 || len(segments) == 3) {
		route := "/{target}/_mapping"
		if len(segments) == 3 {
			route += "/{type}"
		}
		allowRequest(req, RiskDangerous, route, target)
		return true
	}
	return false
}

func classifySettings(req *Request, segments []string, target string) bool {
	method := req.Method
	if (method == "GET" || method == "HEAD") && (len(segments) == 2 || len(segments) == 3) {
		route := "/{target}/_settings"
		if len(segments) == 3 {
			route += "/{name}"
		}
		allowRequest(req, RiskRead, route, target)
		return true
	}
	if (method == "PUT" || method == "POST") && len(segments) == 2 {
		allowRequest(req, RiskDangerous, "/{target}/_settings", target)
		return true
	}
	return false
}

func allowRequest(req *Request, risk Risk, route, target string) {
	req.Risk = risk
	req.IsWrite = risk == RiskNormalWrite || risk == RiskDangerous
	req.Route = route
	req.Target = target
	req.BlockReason = ""
	switch route {
	case "/{target}/_doc", "/{target}/_doc/{id}", "/{target}/_create/{id}",
		"/{target}/{type}", "/{target}/{type}/{id}", "/{target}/_update_by_query":
		req.MayRunIngestPipeline = req.Method == "POST" || req.Method == "PUT"
	default:
		req.MayRunIngestPipeline = false
	}
}

func blockRequest(req *Request, reason string) {
	req.Risk = RiskBlocked
	req.Route = ""
	req.Target = ""
	req.BlockReason = reason
}

func splitPath(decodedPath string) []string {
	trimmed := strings.Trim(decodedPath, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func allowedCATEndpoint(endpoint string) bool {
	switch endpoint {
	case "indices", "aliases", "count", "shards", "health":
		return true
	default:
		return false
	}
}

func systemIndexTarget(target string) bool {
	for _, name := range strings.Split(target, ",") {
		name = strings.TrimSpace(name)
		if strings.HasPrefix(name, ".") {
			return true
		}
	}
	return false
}

func unsafeDeleteTarget(target string) bool {
	target = strings.TrimSpace(target)
	return target == "" || target == "_all" || strings.ContainsAny(target, "*?,:<>{}") || systemIndexTarget(target)
}

func explicitIndexTarget(target string) bool {
	target = strings.TrimSpace(target)
	return target != "" && target != "_all" && !strings.ContainsAny(target, "*?,:<>{}") && !systemIndexTarget(target)
}

func explicitMultiIndexTarget(target string) bool {
	names := strings.Split(strings.TrimSpace(target), ",")
	if len(names) == 0 || len(names) > MaxWriteTargets {
		return false
	}
	for _, name := range names {
		if !explicitIndexTarget(name) {
			return false
		}
	}
	return true
}

func joinSortedTargets(targets map[string]struct{}) string {
	values := make([]string, 0, len(targets))
	for target := range targets {
		values = append(values, target)
	}
	sort.Strings(values)
	return strings.Join(values, ",")
}
