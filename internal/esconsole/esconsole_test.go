package esconsole_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"GoNavi-Wails/internal/esconsole"
)

func TestParseSourceParsesDevToolsBatch(t *testing.T) {
	source := "# inspect and mutate\r\n" +
		"GET /logs/_search?pretty=true\r\n" +
		"{\"query\":{\"match_all\":{}}}\r\n\r\n" +
		"// create a document\r\n" +
		"POST /logs/_doc\r\n" +
		"{\"message\":\"created\"}\r\n" +
		"PUT /logs/_doc/42\r\n" +
		"{\"message\":\"updated\"}\r\n" +
		"HEAD /logs/_doc/42\r\n" +
		"DELETE /logs/_doc/42\r\n"

	batch, err := esconsole.ParseSource(source, "")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}

	wantMethods := []string{"GET", "POST", "PUT", "HEAD", "DELETE"}
	wantPaths := []string{
		"/logs/_search?pretty=true",
		"/logs/_doc",
		"/logs/_doc/42",
		"/logs/_doc/42",
		"/logs/_doc/42",
	}
	if len(batch.Requests) != len(wantMethods) {
		t.Fatalf("request count = %d, want %d", len(batch.Requests), len(wantMethods))
	}
	for i := range batch.Requests {
		if batch.Requests[i].Method != wantMethods[i] {
			t.Errorf("request[%d].Method = %q, want %q", i, batch.Requests[i].Method, wantMethods[i])
		}
		if batch.Requests[i].Path != wantPaths[i] {
			t.Errorf("request[%d].Path = %q, want %q", i, batch.Requests[i].Path, wantPaths[i])
		}
	}
	if got := batch.Requests[0].Body; got != `{"query":{"match_all":{}}}` {
		t.Errorf("first body = %q", got)
	}
	if got := batch.Requests[3].Body; got != "" {
		t.Errorf("HEAD body = %q, want empty", got)
	}
}

func TestParseSourceRejectsSourceLargerThanLimit(t *testing.T) {
	source := strings.Repeat("x", esconsole.MaxSourceBytes+1)
	_, err := esconsole.ParseSource(source, "logs")
	var parseErr *esconsole.ParseError
	if !errors.As(err, &parseErr) {
		t.Fatalf("error = %v, want *ParseError", err)
	}
	if parseErr.Code != esconsole.CodeSourceTooLarge {
		t.Fatalf("error code = %q, want %q", parseErr.Code, esconsole.CodeSourceTooLarge)
	}
}

func TestParseSourceRejectsMoreThanOneHundredRequests(t *testing.T) {
	source := strings.Repeat("GET /_cluster/health\n", esconsole.MaxRequests+1)
	_, err := esconsole.ParseSource(source, "")
	var parseErr *esconsole.ParseError
	if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeTooManyRequests {
		t.Fatalf("error = %v, want code %q", err, esconsole.CodeTooManyRequests)
	}
}

func TestParseSourceRejectsUnsafeRESTTargets(t *testing.T) {
	tests := []struct {
		name   string
		source string
	}{
		{name: "absolute URL", source: "GET http://example.test/_search"},
		{name: "userinfo", source: "GET http://user:password@example.test/_search"},
		{name: "authority", source: "GET //user@example.test/_search"},
		{name: "fragment", source: "GET /logs/_search#fragment"},
		{name: "control character", source: "GET /logs/_search?q=%0Ainjected"},
		{name: "raw backslash", source: `GET /logs\_search`},
		{name: "dot segment", source: "GET /logs/../_search"},
		{name: "encoded dot segment", source: "GET /logs/%2e%2e/_search"},
		{name: "encoded slash", source: "GET /logs%2fprivate/_search"},
		{name: "encoded backslash", source: "GET /logs%5cprivate/_search"},
		{name: "double encoding", source: "GET /logs/%252fprivate/_search"},
		{name: "repeated slash", source: "GET /logs//_search"},
		{name: "source query body", source: "GET /logs/_search?source=%7B%22script_fields%22%3A%7B%7D%7D&source_content_type=application%2Fjson"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := esconsole.ParseSource(tt.source, "")
			var parseErr *esconsole.ParseError
			if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeUnsafePath {
				t.Fatalf("error = %v, want code %q", err, esconsole.CodeUnsafePath)
			}
		})
	}
}

func TestParseSourceRejectsUnsupportedRESTMethod(t *testing.T) {
	for _, source := range []string{"PATCH /logs/_doc/42\n{}", "BREW /logs/_doc/42"} {
		_, err := esconsole.ParseSource(source, "")
		var parseErr *esconsole.ParseError
		if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeUnsupportedMethod {
			t.Fatalf("source %q error = %v, want code %q", source, err, esconsole.CodeUnsupportedMethod)
		}
	}
}

func TestParseSourceClassifiesAllowedAndBlockedEndpoints(t *testing.T) {
	tests := []struct {
		name       string
		source     string
		wantRisk   esconsole.Risk
		wantRoute  string
		wantTarget string
		wantReason string
	}{
		{name: "root", source: "GET /", wantRisk: esconsole.RiskRead, wantRoute: "/"},
		{name: "global search", source: "POST /_search\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/_search"},
		{name: "global validate query", source: "POST /_validate/query\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/_validate/query"},
		{name: "global multi term vectors", source: "POST /_mtermvectors\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/_mtermvectors"},
		{name: "global field mapping", source: "GET /_mapping/field/message", wantRisk: esconsole.RiskRead, wantRoute: "/_mapping/field/{fields}"},
		{name: "index search", source: "GET /logs-*/_search", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_search", wantTarget: "logs-*"},
		{name: "multi search", source: "POST /logs/_msearch\n{}\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_msearch", wantTarget: "logs"},
		{name: "count", source: "GET /logs/_count", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_count", wantTarget: "logs"},
		{name: "get document", source: "GET /logs/_doc/42", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_doc/{id}", wantTarget: "logs"},
		{name: "head source", source: "HEAD /logs/_source/42", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_source/{id}", wantTarget: "logs"},
		{name: "multi get", source: "POST /logs/_mget\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_mget", wantTarget: "logs"},
		{name: "explain", source: "POST /logs/_explain/42\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_explain/{id}", wantTarget: "logs"},
		{name: "term vectors", source: "POST /logs/_termvectors/42\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_termvectors/{id}", wantTarget: "logs"},
		{name: "multi term vectors", source: "POST /logs/_mtermvectors\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_mtermvectors", wantTarget: "logs"},
		{name: "field caps", source: "POST /logs/_field_caps\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_field_caps", wantTarget: "logs"},
		{name: "validate query", source: "POST /logs/_validate/query\n{}", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_validate/query", wantTarget: "logs"},
		{name: "mapping", source: "GET /logs/_mapping", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_mapping", wantTarget: "logs"},
		{name: "field mapping", source: "GET /logs/_mapping/field/message", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_mapping/field/{fields}", wantTarget: "logs"},
		{name: "settings", source: "GET /logs/_settings/index.number_of_shards", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_settings/{name}", wantTarget: "logs"},
		{name: "alias", source: "GET /logs/_alias/current", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_alias/{name}", wantTarget: "logs"},
		{name: "resolve index", source: "GET /_resolve/index/logs-*", wantRisk: esconsole.RiskRead, wantRoute: "/_resolve/index/{name}", wantTarget: "logs-*"},
		{name: "index stats", source: "GET /logs/_stats/docs", wantRisk: esconsole.RiskRead, wantRoute: "/{target}/_stats/{metric}", wantTarget: "logs"},
		{name: "cluster health", source: "GET /_cluster/health/logs", wantRisk: esconsole.RiskRead, wantRoute: "/_cluster/health/{target}", wantTarget: "logs"},
		{name: "cat indices", source: "GET /_cat/indices/logs", wantRisk: esconsole.RiskRead, wantRoute: "/_cat/indices/{target}", wantTarget: "logs"},
		{name: "index info", source: "GET /logs", wantRisk: esconsole.RiskRead, wantRoute: "/{target}", wantTarget: "logs"},
		{name: "create document", source: "POST /logs/_doc\n{}", wantRisk: esconsole.RiskNormalWrite, wantRoute: "/{target}/_doc", wantTarget: "logs"},
		{name: "index document", source: "PUT /logs/_doc/42\n{}", wantRisk: esconsole.RiskNormalWrite, wantRoute: "/{target}/_doc/{id}", wantTarget: "logs"},
		{name: "create with id", source: "PUT /logs/_create/42\n{}", wantRisk: esconsole.RiskNormalWrite, wantRoute: "/{target}/_create/{id}", wantTarget: "logs"},
		{name: "update document", source: "POST /logs/_update/42\n{\"doc\":{\"status\":\"ok\"}}", wantRisk: esconsole.RiskNormalWrite, wantRoute: "/{target}/_update/{id}", wantTarget: "logs"},
		{name: "delete document", source: "DELETE /logs/_doc/42", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}/_doc/{id}", wantTarget: "logs"},
		{name: "bulk", source: "POST /_bulk\n{\"index\":{\"_index\":\"logs\",\"_id\":\"42\"}}\n{}", wantRisk: esconsole.RiskDangerous, wantRoute: "/_bulk", wantTarget: "logs"},
		{name: "update by query", source: "POST /logs/_update_by_query\n{\"script\":{\"source\":\"ctx._source.x=1\"}}", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}/_update_by_query", wantTarget: "logs"},
		{name: "multi target delete by query", source: "POST /logs,archive/_delete_by_query\n{}", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}/_delete_by_query", wantTarget: "logs,archive"},
		{name: "create index", source: "PUT /logs-2026\n{}", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}", wantTarget: "logs-2026"},
		{name: "put mapping", source: "PUT /logs/_mapping\n{}", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}/_mapping", wantTarget: "logs"},
		{name: "put settings", source: "PUT /logs/_settings\n{}", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}/_settings", wantTarget: "logs"},
		{name: "aliases action", source: "POST /_aliases\n{\"actions\":[]}", wantRisk: esconsole.RiskDangerous, wantRoute: "/_aliases"},
		{name: "put alias", source: "PUT /logs/_alias/current\n{}", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}/_alias/{name}", wantTarget: "logs"},
		{name: "close index", source: "POST /logs/_close", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}/_close", wantTarget: "logs"},
		{name: "refresh", source: "POST /logs/_refresh", wantRisk: esconsole.RiskDangerous, wantRoute: "/{target}/_refresh", wantTarget: "logs"},
		{name: "security blocked", source: "GET /_security/_authenticate", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "snapshot blocked", source: "GET /_snapshot", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "nodes blocked", source: "GET /_nodes", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "cluster settings blocked", source: "PUT /_cluster/settings\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "reindex blocked", source: "POST /_reindex\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "stored script blocked", source: "PUT /_scripts/example\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "template blocked", source: "PUT /_index_template/example\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "ingest blocked", source: "PUT /_ingest/pipeline/example\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "lifecycle blocked", source: "GET /_ilm/status", wantRisk: esconsole.RiskBlocked, wantReason: "privileged_endpoint"},
		{name: "system index write blocked", source: "POST /.kibana/_doc\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "system_index_write"},
		{name: "wildcard index delete blocked", source: "DELETE /logs-*", wantRisk: esconsole.RiskBlocked, wantReason: "unsafe_index_delete"},
		{name: "multi index delete blocked", source: "DELETE /logs,archive", wantRisk: esconsole.RiskBlocked, wantReason: "unsafe_index_delete"},
		{name: "all index delete blocked", source: "DELETE /_all", wantRisk: esconsole.RiskBlocked, wantReason: "unsafe_index_delete"},
		{name: "async by query blocked", source: "POST /logs/_delete_by_query?wait_for_completion=false\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "async_by_query"},
		{name: "duplicate async by query blocked", source: "POST /logs/_delete_by_query?wait_for_completion=true&wait_for_completion=false\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "async_by_query"},
		{name: "duplicate async by query reverse order blocked", source: "POST /logs/_delete_by_query?wait_for_completion=false&wait_for_completion=true\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "async_by_query"},
		{name: "bulk response filter blocked", source: "POST /logs/_bulk?filter_path=took\n{\"delete\":{\"_id\":\"42\"}}", wantRisk: esconsole.RiskBlocked, wantReason: "response_filter_not_allowed"},
		{name: "msearch response filter blocked", source: "POST /logs/_msearch?filter_path=responses.hits\n{}\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "response_filter_not_allowed"},
		{name: "write pipeline blocked", source: "PUT /logs/_doc/42?pipeline=redirect\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "pipeline_not_allowed"},
		{name: "bulk metadata pipeline blocked", source: "POST /logs/_bulk\n{\"index\":{\"_id\":\"42\",\"pipeline\":\"redirect\"}}\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "pipeline_not_allowed"},
		{name: "unknown endpoint blocked", source: "POST /logs/_flush", wantRisk: esconsole.RiskBlocked, wantReason: "endpoint_not_allowed"},
		{name: "cross cluster search blocked", source: "GET /remote:logs/_search", wantRisk: esconsole.RiskBlocked, wantReason: "remote_cluster"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			batch, err := esconsole.ParseSource(tt.source, "")
			if err != nil {
				t.Fatalf("ParseSource() error = %v", err)
			}
			if len(batch.Requests) != 1 {
				t.Fatalf("request count = %d, want 1", len(batch.Requests))
			}
			req := batch.Requests[0]
			if req.Risk != tt.wantRisk || req.Route != tt.wantRoute || req.Target != tt.wantTarget || req.BlockReason != tt.wantReason {
				t.Fatalf("classification = risk:%q route:%q target:%q reason:%q", req.Risk, req.Route, req.Target, req.BlockReason)
			}
		})
	}
}

func TestParseSourceValidatesAndNormalizesJSONBodies(t *testing.T) {
	source := "POST /logs/_search\n" +
		"{\n" +
		"  # DevTools comment\n" +
		"  \"query\": {\"match_all\": {}}\n" +
		"}"
	batch, err := esconsole.ParseSource(source, "")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	req := batch.Requests[0]
	if req.BodyKind != esconsole.BodyJSON || req.Body != `{"query":{"match_all":{}}}` {
		t.Fatalf("normalized body = kind:%q body:%q", req.BodyKind, req.Body)
	}

	for _, invalidBody := range []string{`{"query":}`, `[]`, `{}\n{}`} {
		_, err := esconsole.ParseSource("POST /logs/_search\n"+invalidBody, "")
		var parseErr *esconsole.ParseError
		if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeInvalidJSON {
			t.Errorf("body %q error = %v, want code %q", invalidBody, err, esconsole.CodeInvalidJSON)
		}
	}
}

func TestParseSourceDetectsExecutableScriptsWithoutFlaggingDocumentFields(t *testing.T) {
	tests := []struct {
		name       string
		source     string
		wantScript bool
		wantRisk   esconsole.Risk
	}{
		{
			name:       "script fields in search",
			source:     `POST /logs/_search` + "\n" + `{"script_fields":{"computed":{"script":{"source":"doc['x'].value"}}}}`,
			wantScript: true,
			wantRisk:   esconsole.RiskDangerous,
		},
		{
			name:       "script score in search",
			source:     `POST /logs/_search` + "\n" + `{"query":{"script_score":{"query":{"match_all":{}},"script":{"source":"1"}}}}`,
			wantScript: true,
			wantRisk:   esconsole.RiskDangerous,
		},
		{
			name:       "script query in search",
			source:     `POST /logs/_search` + "\n" + `{"query":{"script":{"script":{"source":"doc['x'].value > 1"}}}}`,
			wantScript: true,
			wantRisk:   esconsole.RiskDangerous,
		},
		{
			name:       "scripted update is dangerous",
			source:     `POST /logs/_update/42` + "\n" + `{"script":{"source":"ctx._source.x=1"}}`,
			wantScript: true,
			wantRisk:   esconsole.RiskDangerous,
		},
		{
			name:       "document field named script is data",
			source:     `POST /logs/_update/42` + "\n" + `{"doc":{"script":"plain text"}}`,
			wantScript: false,
			wantRisk:   esconsole.RiskNormalWrite,
		},
		{
			name:       "indexed document field named script is data",
			source:     `PUT /logs/_doc/42` + "\n" + `{"script":"plain text"}`,
			wantScript: false,
			wantRisk:   esconsole.RiskNormalWrite,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			batch, err := esconsole.ParseSource(tt.source, "")
			if err != nil {
				t.Fatalf("ParseSource() error = %v", err)
			}
			req := batch.Requests[0]
			if req.ContainsScript != tt.wantScript || batch.ContainsScript != tt.wantScript || req.Risk != tt.wantRisk {
				t.Fatalf("script classification = request:%v batch:%v risk:%q", req.ContainsScript, batch.ContainsScript, req.Risk)
			}
		})
	}
}

func TestParseSourceNormalizesMultiSearchNDJSON(t *testing.T) {
	source := "POST /logs/_msearch\n" +
		"{ \"preference\": \"local\" }\n" +
		"{ \"query\": { \"match_all\": {} } }"
	batch, err := esconsole.ParseSource(source, "")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	req := batch.Requests[0]
	wantBody := "{\"preference\":\"local\"}\n{\"query\":{\"match_all\":{}}}\n"
	if req.BodyKind != esconsole.BodyNDJSON || req.Body != wantBody || req.OperationCount != 1 {
		t.Fatalf("msearch body = kind:%q operations:%d body:%q", req.BodyKind, req.OperationCount, req.Body)
	}

	_, err = esconsole.ParseSource("POST /_msearch\n{}\n{}\n{}", "")
	var parseErr *esconsole.ParseError
	if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeInvalidNDJSON {
		t.Fatalf("odd msearch error = %v, want code %q", err, esconsole.CodeInvalidNDJSON)
	}
}

func TestParseSourceValidatesAndNormalizesBulkNDJSON(t *testing.T) {
	source := "POST /_bulk\n" +
		`{"index":{"_index":"logs","_id":"1"}}` + "\n" +
		`{"message":"created"}` + "\n" +
		`{"delete":{"_index":"logs","_id":"2"}}` + "\n" +
		`{"update":{"_index":"logs","_id":"3"}}` + "\n" +
		`{"script":{"source":"ctx._source.count++"}}`
	batch, err := esconsole.ParseSource(source, "")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	req := batch.Requests[0]
	if req.BodyKind != esconsole.BodyNDJSON || !strings.HasSuffix(req.Body, "\n") {
		t.Fatalf("bulk body was not normalized: kind=%q body=%q", req.BodyKind, req.Body)
	}
	if req.OperationCount != 3 || !req.ContainsScript || !req.IsWrite || req.Risk != esconsole.RiskDangerous {
		t.Fatalf("bulk classification = operations:%d script:%v write:%v risk:%q", req.OperationCount, req.ContainsScript, req.IsWrite, req.Risk)
	}
}

func TestParseSourceRejectsMalformedBulkNDJSON(t *testing.T) {
	tests := []string{
		`{"noop":{"_index":"logs"}}`,
		`{"index":{"_index":"logs"},"delete":{"_index":"logs"}}`,
		`{"index":"logs"}`,
		`{"index":{"_index":"logs"}}`,
		`{"delete":{"_index":"logs"}}` + "\n" + `{"message":"unexpected source"}`,
		`{"index":{}}` + "\n" + `{}`,
	}
	for _, body := range tests {
		_, err := esconsole.ParseSource("POST /_bulk\n"+body, "")
		var parseErr *esconsole.ParseError
		if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeInvalidNDJSON {
			t.Errorf("body %q error = %v, want code %q", body, err, esconsole.CodeInvalidNDJSON)
		}
	}
}

func TestParseSourceBlocksUnsafeBulkTargets(t *testing.T) {
	for _, tt := range []struct {
		name   string
		index  string
		reason string
	}{
		{name: "system index", index: ".kibana", reason: "system_index_write"},
		{name: "wildcard", index: "logs-*", reason: "bulk_target_not_allowed"},
		{name: "multiple indices", index: "logs,archive", reason: "bulk_target_not_allowed"},
		{name: "date math system index", index: "<.watcher-history-{now{yyyy.MM.dd}}>", reason: "bulk_target_not_allowed"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			source := "POST /_bulk\n" +
				`{"index":{"_index":"` + tt.index + `"}}` + "\n" +
				`{}`
			batch, err := esconsole.ParseSource(source, "")
			if err != nil {
				t.Fatalf("ParseSource() error = %v", err)
			}
			req := batch.Requests[0]
			if req.Risk != esconsole.RiskBlocked || req.BlockReason != tt.reason || !req.IsWrite {
				t.Fatalf("bulk target classification = risk:%q reason:%q write:%v", req.Risk, req.BlockReason, req.IsWrite)
			}
		})
	}
}

func TestParseSourceEnforcesNDJSONLineAndBulkActionLimits(t *testing.T) {
	t.Run("NDJSON line", func(t *testing.T) {
		bodies := []string{
			`{"metadata":"` + strings.Repeat("x", esconsole.MaxNDJSONLineBytes) + `"}` + "\n{}",
			strings.Repeat(" ", esconsole.MaxNDJSONLineBytes+1) + "{}\n{}",
		}
		for _, body := range bodies {
			_, err := esconsole.ParseSource("POST /_msearch\n"+body, "")
			var parseErr *esconsole.ParseError
			if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeNDJSONLineTooLarge {
				t.Fatalf("error = %v, want code %q", err, esconsole.CodeNDJSONLineTooLarge)
			}
		}
	})

	t.Run("Bulk action count", func(t *testing.T) {
		var source strings.Builder
		source.WriteString("POST /logs/_bulk\n")
		for i := 0; i < esconsole.MaxBulkActions+1; i++ {
			source.WriteString("{\"delete\":{\"_id\":\"1\"}}\n")
		}
		_, err := esconsole.ParseSource(source.String(), "")
		var parseErr *esconsole.ParseError
		if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeTooManyBulkActions {
			t.Fatalf("error = %v, want code %q", err, esconsole.CodeTooManyBulkActions)
		}
	})

	t.Run("multi-search request count", func(t *testing.T) {
		var source strings.Builder
		source.WriteString("POST /logs/_msearch\n")
		for i := 0; i < esconsole.MaxRequests+1; i++ {
			source.WriteString("{}\n{}\n")
		}
		_, err := esconsole.ParseSource(source.String(), "")
		var parseErr *esconsole.ParseError
		if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeTooManyRequests {
			t.Fatalf("error = %v, want code %q", err, esconsole.CodeTooManyRequests)
		}
	})
}

func TestParseSourceBlocksSystemIndexAliasActions(t *testing.T) {
	source := "POST /_aliases\n" +
		`{"actions":[{"add":{"index":".kibana","alias":"visible"}}]}`
	batch, err := esconsole.ParseSource(source, "")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	req := batch.Requests[0]
	if req.Risk != esconsole.RiskBlocked || req.BlockReason != "system_index_write" || !req.IsWrite {
		t.Fatalf("alias classification = risk:%q reason:%q write:%v", req.Risk, req.BlockReason, req.IsWrite)
	}
}

func TestParseSourceBlocksMultipleRemoveIndexAliasActions(t *testing.T) {
	source := "POST /_aliases\n" +
		`{"actions":[{"remove_index":{"index":"logs-a"}},{"remove_index":{"index":"logs-b"}}]}`
	batch, err := esconsole.ParseSource(source, "")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	req := batch.Requests[0]
	if req.Risk != esconsole.RiskBlocked || req.BlockReason != "unsafe_index_delete" || !req.IsWrite {
		t.Fatalf("multi-index alias delete classification = risk:%q reason:%q write:%v", req.Risk, req.BlockReason, req.IsWrite)
	}
}

func TestParseSourceBlocksDateMathWriteTargets(t *testing.T) {
	tests := []string{
		"PUT /%3C.watcher-history-16-%7Bnow%7Byyyy.MM.dd%7D%7D%3E/_doc/42\n{}",
		"POST /_aliases\n{\"actions\":[{\"add\":{\"index\":\"<.security-{now/d}>\",\"alias\":\"visible\"}}]}",
	}
	for _, source := range tests {
		batch, err := esconsole.ParseSource(source, "")
		if err != nil {
			t.Fatalf("ParseSource(%q) error = %v", source, err)
		}
		if len(batch.Requests) != 1 || batch.Requests[0].Risk != esconsole.RiskBlocked {
			t.Fatalf("date-math write was not blocked: %+v", batch)
		}
	}
}

func TestParseSourceReturnsStableErrorsForCompatibilityInputs(t *testing.T) {
	tests := []struct {
		name         string
		source       string
		defaultIndex string
		wantCode     esconsole.ErrorCode
	}{
		{name: "empty", source: " \n# comment", wantCode: esconsole.CodeEmptySource},
		{name: "invalid JSON DSL", source: `{"query":}`, defaultIndex: "logs", wantCode: esconsole.CodeInvalidJSON},
		{name: "missing default index", source: `{}`, wantCode: esconsole.CodeDefaultIndexNeeded},
		{name: "default index path injection", source: `{}`, defaultIndex: "logs/other", wantCode: esconsole.CodeUnsafePath},
		{name: "default index query injection", source: `{}`, defaultIndex: "logs?pretty=true", wantCode: esconsole.CodeUnsafePath},
		{name: "remote default index", source: `{}`, defaultIndex: "remote:logs", wantCode: esconsole.CodeUnsafePath},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := esconsole.ParseSource(tt.source, tt.defaultIndex)
			var parseErr *esconsole.ParseError
			if !errors.As(err, &parseErr) || parseErr.Code != tt.wantCode {
				t.Fatalf("error = %v, want code %q", err, tt.wantCode)
			}
		})
	}
}

func TestParseSourceRequiresExplicitTargetsForDirectWrites(t *testing.T) {
	tests := []struct {
		name       string
		source     string
		wantRisk   esconsole.Risk
		wantReason string
	}{
		{name: "document wildcard", source: "POST /logs-*/_doc\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "write_target_not_allowed"},
		{name: "document multiple targets", source: "PUT /logs,archive/_doc/42\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "write_target_not_allowed"},
		{name: "create wildcard index", source: "PUT /logs-*\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "index_target_not_allowed"},
		{name: "multi-target by query remains dangerous", source: "POST /logs,archive/_delete_by_query\n{}", wantRisk: esconsole.RiskDangerous},
		{name: "wildcard by query blocked", source: "POST /*/_delete_by_query\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "write_target_not_allowed"},
		{name: "wildcard settings blocked", source: "PUT /*/_settings\n{}", wantRisk: esconsole.RiskBlocked, wantReason: "write_target_not_allowed"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			batch, err := esconsole.ParseSource(tt.source, "")
			if err != nil {
				t.Fatalf("ParseSource() error = %v", err)
			}
			req := batch.Requests[0]
			if req.Risk != tt.wantRisk || req.BlockReason != tt.wantReason {
				t.Fatalf("classification = risk:%q reason:%q", req.Risk, req.BlockReason)
			}
		})
	}
}

func TestTypedEndpointsRequireElasticsearch6(t *testing.T) {
	for _, source := range []string{
		"PUT /logs/event/42\n{}",
		"POST /logs/event/_search\n{}",
	} {
		batch, err := esconsole.ParseSourceForMajor(source, "", 6)
		if err != nil || len(batch.Requests) != 1 || batch.Requests[0].Risk == esconsole.RiskBlocked {
			t.Fatalf("ES6 typed request was not allowed: batch=%+v err=%v", batch, err)
		}
		for _, major := range []int{0, 7, 8} {
			blocked, parseErr := esconsole.ParseSourceForMajor(source, "", major)
			if parseErr != nil || len(blocked.Requests) != 1 || blocked.Requests[0].Risk != esconsole.RiskBlocked {
				t.Fatalf("typed request for ES %d = %+v, err=%v; want blocked", major, blocked, parseErr)
			}
		}
	}
}

func TestGlobalAndWildcardIndexWritesAreBlocked(t *testing.T) {
	tests := []struct {
		name   string
		source string
	}{
		{name: "global refresh", source: "POST /_refresh"},
		{name: "wildcard mapping", source: "PUT /*/_mapping\n{}"},
		{name: "wildcard alias", source: "PUT /*/_alias/current\n{}"},
		{name: "wildcard alias action", source: "POST /_aliases\n{\"actions\":[{\"add\":{\"index\":\"*\",\"alias\":\"all\"}}]}"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			batch, err := esconsole.ParseSource(test.source, "")
			if err != nil {
				t.Fatalf("ParseSource error: %v", err)
			}
			if len(batch.Requests) != 1 || batch.Requests[0].Risk != esconsole.RiskBlocked {
				t.Fatalf("request was not blocked: %+v", batch)
			}
		})
	}
}

func TestRequestsRequiringBodiesRejectIncompleteInput(t *testing.T) {
	for _, source := range []string{
		"PUT /logs/_doc/42",
		"POST /logs/_update/42",
		"POST /_aliases",
		"PUT /logs/_mapping",
		"PUT /logs/_settings",
		"POST /logs/_delete_by_query",
		"GET /_mget",
		"POST /logs/_mget",
		"GET /_mtermvectors",
		"POST /logs/_mtermvectors",
		"POST /logs/_termvectors",
		"POST /logs/_explain/42",
	} {
		_, err := esconsole.ParseSource(source, "")
		var parseErr *esconsole.ParseError
		if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeBodyRequired {
			t.Fatalf("source %q error = %v, want %q", source, err, esconsole.CodeBodyRequired)
		}
	}
}

func TestBulkRejectsTooManyUniqueWriteTargets(t *testing.T) {
	var source strings.Builder
	source.WriteString("POST /_bulk\n")
	for i := 0; i < esconsole.MaxWriteTargets+1; i++ {
		fmt.Fprintf(&source, "{\"delete\":{\"_index\":\"logs-%d\",\"_id\":\"42\"}}\n", i)
	}
	_, err := esconsole.ParseSource(source.String(), "")
	var parseErr *esconsole.ParseError
	if !errors.As(err, &parseErr) || parseErr.Code != esconsole.CodeTooManyWriteTargets {
		t.Fatalf("error = %v, want code %q", err, esconsole.CodeTooManyWriteTargets)
	}
}

func TestMsearchRejectsCrossClusterHeader(t *testing.T) {
	batch, err := esconsole.ParseSource("POST /_msearch\n{\"index\":\"remote:logs\"}\n{}", "")
	if err != nil {
		t.Fatalf("ParseSource error: %v", err)
	}
	if len(batch.Requests) != 1 || batch.Requests[0].Risk != esconsole.RiskBlocked || batch.Requests[0].BlockReason != "remote_cluster" {
		t.Fatalf("cross-cluster msearch was not blocked: %+v", batch)
	}
}

func TestBatchSummarizesWriteAndConfirmationPolicy(t *testing.T) {
	tests := []struct {
		name        string
		source      string
		wantWrite   bool
		wantConfirm bool
		wantBlocked bool
	}{
		{name: "read", source: "GET /logs/_search", wantWrite: false},
		{name: "normal write", source: "PUT /logs/_doc/42\n{}", wantWrite: true},
		{name: "dangerous write", source: "DELETE /logs/_doc/42", wantWrite: true, wantConfirm: true},
		{name: "blocked system write", source: "PUT /.kibana/_doc/42\n{}", wantWrite: true, wantBlocked: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			batch, err := esconsole.ParseSource(tt.source, "")
			if err != nil {
				t.Fatalf("ParseSource() error = %v", err)
			}
			if batch.ContainsWrite != tt.wantWrite || batch.RequiresConfirmation != tt.wantConfirm || batch.Blocked != tt.wantBlocked {
				t.Fatalf("batch summary = write:%v confirm:%v blocked:%v", batch.ContainsWrite, batch.RequiresConfirmation, batch.Blocked)
			}
			if batch.Requests[0].IsWrite != tt.wantWrite {
				t.Fatalf("request IsWrite = %v, want %v", batch.Requests[0].IsWrite, tt.wantWrite)
			}
		})
	}
}

func TestParseSourceWrapsJSONDSLAsReadRequest(t *testing.T) {
	batch, err := esconsole.ParseSource(`{"query":{"match_all":{}}}`, "logs-*")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	if len(batch.Requests) != 1 {
		t.Fatalf("request count = %d, want 1", len(batch.Requests))
	}
	req := batch.Requests[0]
	if req.Kind != esconsole.KindJSONDSL {
		t.Errorf("Kind = %q, want %q", req.Kind, esconsole.KindJSONDSL)
	}
	if req.Method != "POST" || req.Path != "/logs-*/_search" {
		t.Errorf("request = %s %s", req.Method, req.Path)
	}
	if req.Risk != esconsole.RiskRead {
		t.Errorf("Risk = %q, want %q", req.Risk, esconsole.RiskRead)
	}
	if req.BodyKind != esconsole.BodyJSON {
		t.Errorf("BodyKind = %q, want %q", req.BodyKind, esconsole.BodyJSON)
	}
	if len(req.BodySHA256) != 64 || len(batch.Fingerprint) != 64 {
		t.Errorf("hashes were not populated: body=%q batch=%q", req.BodySHA256, batch.Fingerprint)
	}
	if strings.Contains(req.Body, "\n") {
		t.Errorf("compact JSON body contains a newline: %q", req.Body)
	}
}

func TestParseSourceRecognizesJSONDSLAfterComments(t *testing.T) {
	source := "# inspect logs\r\n// second comment\r\n{\r\n  \"query\": {\"match_all\": {}}\r\n}"
	batch, err := esconsole.ParseSource(source, "logs")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	if len(batch.Requests) != 1 || batch.Requests[0].Kind != esconsole.KindJSONDSL {
		t.Fatalf("request = %#v", batch.Requests)
	}
}

func TestParseSourceConvertsSimplifiedSelectToClassifiedSearch(t *testing.T) {
	const source = `SELECT * FROM "logs-2026" LIMIT 20`
	batch, err := esconsole.ParseSource(source, "fallback-index")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	if len(batch.Requests) != 1 {
		t.Fatalf("request count = %d, want 1", len(batch.Requests))
	}
	req := batch.Requests[0]
	if req.Kind != esconsole.KindREST || req.Risk != esconsole.RiskRead {
		t.Errorf("SELECT classification = (%q, %q)", req.Kind, req.Risk)
	}
	if req.Method != "POST" || req.Path != "/logs-2026/_search" || req.BodyKind != esconsole.BodyJSON {
		t.Errorf("SELECT request = %#v", req)
	}
	if !strings.Contains(req.Body, `"size":20`) || !strings.Contains(req.Body, `"match_all"`) {
		t.Errorf("SELECT body = %s", req.Body)
	}
}

func TestParseSourceRejectsSimplifiedSelectURLAndRemoteTargets(t *testing.T) {
	for _, source := range []string{
		`SELECT * FROM "orders/_delete_by_query?pretty=true#"`,
		`SELECT * FROM "orders%252f_delete_by_query"`,
		`SELECT * FROM "remote:index"`,
		"SELECT * FROM \"orders\\_search\"",
	} {
		t.Run(source, func(t *testing.T) {
			if _, err := esconsole.ParseSource(source, "fallback-index"); err == nil {
				t.Fatalf("ParseSource(%q) unexpectedly succeeded", source)
			}
		})
	}
}

func TestParseSourceConvertsQueryStringToSelectedIndexSearch(t *testing.T) {
	batch, err := esconsole.ParseSource("status:open", "orders")
	if err != nil {
		t.Fatalf("ParseSource() error = %v", err)
	}
	if len(batch.Requests) != 1 {
		t.Fatalf("request count = %d, want 1", len(batch.Requests))
	}
	req := batch.Requests[0]
	if req.Kind != esconsole.KindREST || req.Method != "POST" || req.Path != "/orders/_search" || req.Risk != esconsole.RiskRead {
		t.Fatalf("query_string request = %+v", req)
	}
	if !strings.Contains(req.Body, `"query":"status:open"`) {
		t.Fatalf("query_string body = %s", req.Body)
	}
}
