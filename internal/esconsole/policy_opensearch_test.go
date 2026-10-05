package esconsole_test

import (
	"testing"

	"GoNavi-Wails/internal/esconsole"
)

func parseSingleRequest(t *testing.T, source string) esconsole.Request {
	t.Helper()
	batch, err := esconsole.ParseSourceForMajor(source, "", 7)
	if err != nil {
		t.Fatalf("ParseSourceForMajor(%q) error = %v", source, err)
	}
	if len(batch.Requests) != 1 {
		t.Fatalf("request count = %d", len(batch.Requests))
	}
	return batch.Requests[0]
}

func TestOpenSearchSQLAndPPLQueriesAreReadOnly(t *testing.T) {
	for source, route := range map[string]string{
		"POST /_plugins/_sql\n{\"query\": \"SELECT sku, qty FROM orders ORDER BY qty\"}":   "/_plugins/_sql",
		"POST /_plugins/_sql?format=jdbc\n{\"query\": \"show tables like orders%\"}":       "/_plugins/_sql",
		"POST /_plugins/_sql/_explain\n{\"query\": \"SELECT * FROM orders\"}":              "/_plugins/_sql/_explain",
		"POST /_plugins/_ppl\n{\"query\": \"source=orders | where qty > 4 | fields sku\"}": "/_plugins/_ppl",
	} {
		request := parseSingleRequest(t, source)
		if request.Risk != esconsole.RiskRead || request.IsWrite || request.Route != route {
			t.Fatalf("%q classified as risk=%s write=%v route=%q reason=%q", source, request.Risk, request.IsWrite, request.Route, request.BlockReason)
		}
	}
}

func TestOpenSearchPluginWritesAndAdminEndpointsAreBlocked(t *testing.T) {
	for source, reason := range map[string]string{
		"POST /_plugins/_sql\n{\"query\": \"DELETE FROM orders WHERE qty = 0\"}": "sql_not_read_only",
		"POST /_plugins/_sql\nnot-json":                                          "sql_not_read_only",
		"GET /_plugins/_security/api/internalusers":                              "endpoint_not_allowed",
		"POST /_plugins/_ism/add/orders\n{\"policy_id\": \"p\"}":                 "endpoint_not_allowed",
		"GET /_plugins/_sql":                                                     "endpoint_not_allowed",
	} {
		request := parseSingleRequest(t, source)
		if request.Risk != esconsole.RiskBlocked || request.BlockReason != reason {
			t.Fatalf("%q classified as risk=%s reason=%q, want blocked %q", source, request.Risk, request.BlockReason, reason)
		}
	}
}
