//go:build gonavi_full_drivers || gonavi_elasticsearch_driver

package db

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
)

func TestElasticsearchBulkPartialFailureListsAllItems(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/_alias/test-index":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
			writeJSON(w, map[string]interface{}{
				"errors": true,
				"items": []interface{}{
					map[string]interface{}{"index": map[string]interface{}{"_id": "doc-ok", "status": 201}},
					map[string]interface{}{"index": map[string]interface{}{
						"_id":    "doc-bad-type",
						"status": 400,
						"error":  map[string]interface{}{"type": "mapper_parsing_exception", "reason": "failed to parse field [age]"},
					}},
					map[string]interface{}{"update": map[string]interface{}{
						"_id":    "doc-conflict",
						"status": 409,
						"error":  map[string]interface{}{"type": "version_conflict_engine_exception", "reason": "version conflict, current version [2] is different than the one provided [1]"},
					}},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	err := newTestESDB(t, server.URL, "test-index").ApplyChanges("test-index", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"_id": "doc-ok", "message": "hello"}, {"_id": "doc-bad-type", "age": "x"}},
		Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"_id": "doc-conflict"}, Values: map[string]interface{}{"message": "retry"}}},
	})
	if err == nil {
		t.Fatal("expected bulk partial failure, got success")
	}
	if IsWriteOutcomeUnknown(err) {
		t.Fatalf("partial bulk failure must stay a known error, got unknown outcome: %v", err)
	}
	got := err.Error()
	for _, want := range []string{
		"ES 批量操作部分失败",
		"成功 1 条",
		"失败 2 条",
		"doc-bad-type",
		"failed to parse field [age]",
		"doc-conflict",
		"version conflict",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("ApplyChanges error %q missing %q", got, want)
		}
	}
}

func TestElasticsearchBulkPartialFailureTruncatesLongLists(t *testing.T) {
	items := make([]interface{}, 0, 25)
	for i := 1; i <= 25; i++ {
		items = append(items, map[string]interface{}{"index": map[string]interface{}{
			"_id":    fmt.Sprintf("doc-%02d", i),
			"status": 400,
			"error":  map[string]interface{}{"reason": "mapper_parsing_exception"},
		}})
	}
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/_alias/test-index":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
			writeJSON(w, map[string]interface{}{"errors": true, "items": items})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	inserts := make([]map[string]interface{}, 0, 25)
	for i := 1; i <= 25; i++ {
		inserts = append(inserts, map[string]interface{}{"_id": fmt.Sprintf("doc-%02d", i), "message": "x"})
	}
	err := newTestESDB(t, server.URL, "test-index").ApplyChanges("test-index", connection.ChangeSet{Inserts: inserts})
	if err == nil {
		t.Fatal("expected bulk partial failure, got success")
	}
	got := err.Error()
	if !strings.Contains(got, "失败 25 条") {
		t.Fatalf("ApplyChanges error %q missing failure count", got)
	}
	if !strings.Contains(got, "其余 5 条省略") {
		t.Fatalf("ApplyChanges error %q missing truncation marker", got)
	}
	if !strings.Contains(got, "doc-20") {
		t.Fatalf("ApplyChanges error %q missing last listed id", got)
	}
	if strings.Contains(got, "doc-21") {
		t.Fatalf("ApplyChanges error listed truncated id: %q", got)
	}
}

func TestElasticsearchBulkPartialFailureSanitizesControlCharacters(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/_alias/test-index":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
			writeJSON(w, map[string]interface{}{
				"errors": true,
				"items": []interface{}{
					map[string]interface{}{"index": map[string]interface{}{
						"_id":    "doc-\ninjected",
						"status": 400,
						"error":  map[string]interface{}{"reason": "bad\nWARN fake-line"},
					}},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	err := newTestESDB(t, server.URL, "test-index").ApplyChanges("test-index", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"_id": "doc-injected", "message": "x"}},
	})
	if err == nil {
		t.Fatal("expected bulk partial failure, got success")
	}
	got := err.Error()
	if strings.ContainsAny(got, "\n\r") {
		t.Fatalf("failure message still contains control characters: %q", got)
	}
	if !strings.Contains(got, "doc- injected") && !strings.Contains(got, "doc-injected") {
		t.Fatalf("sanitized id missing from %q", got)
	}
	if !strings.Contains(got, "bad") || !strings.Contains(got, "WARN fake-line") {
		t.Fatalf("sanitized reason missing from %q", got)
	}
}

func TestElasticsearchBulkPartialFailureTruncatesReasonAndMessage(t *testing.T) {
	longReason := strings.Repeat("R", maxElasticsearchBulkFailureReasonRunes+50)
	longID := strings.Repeat("I", maxElasticsearchBulkFailureIDRunes+50)
	items := []interface{}{
		map[string]interface{}{"index": map[string]interface{}{
			"_id":    longID,
			"status": 400,
			"error":  map[string]interface{}{"reason": longReason},
		}},
	}
	for i := 1; i < maxElasticsearchBulkFailureDetails; i++ {
		items = append(items, map[string]interface{}{"index": map[string]interface{}{
			"_id":    fmt.Sprintf("%s-%02d", longID, i),
			"status": 400,
			"error":  map[string]interface{}{"reason": longReason},
		}})
	}

	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/_alias/test-index":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
			writeJSON(w, map[string]interface{}{"errors": true, "items": items})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	err := newTestESDB(t, server.URL, "test-index").ApplyChanges("test-index", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"message": "x"}},
	})
	if err == nil {
		t.Fatal("expected bulk partial failure, got success")
	}
	got := err.Error()
	if strings.Contains(got, strings.Repeat("R", maxElasticsearchBulkFailureReasonRunes+1)) {
		t.Fatalf("reason exceeded %d runes: %q", maxElasticsearchBulkFailureReasonRunes, got)
	}
	if strings.Contains(got, strings.Repeat("I", maxElasticsearchBulkFailureIDRunes+1)) {
		t.Fatalf("id exceeded %d runes: %q", maxElasticsearchBulkFailureIDRunes, got)
	}
	if gotCount := utf8.RuneCountInString(got); gotCount > maxElasticsearchBulkFailureMessageRunes {
		t.Fatalf("failure message has %d runes, want <= %d", gotCount, maxElasticsearchBulkFailureMessageRunes)
	}
}

func TestElasticsearchApplyChangesMarksInvalidBulkJSONAsUnknown(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/_alias/test-index":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("upstream proxy timeout"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestESDB(t, server.URL, "test-index")
	err := db.ApplyChanges("test-index", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"message": "hello"}},
	})
	if err == nil || !strings.Contains(err.Error(), "解析 ES 批量操作响应失败") {
		t.Fatalf("ApplyChanges error = %v, want invalid JSON error", err)
	}
	if !IsWriteOutcomeUnknown(err) {
		t.Fatalf("ApplyChanges error = %v, want unknown write outcome", err)
	}
}
