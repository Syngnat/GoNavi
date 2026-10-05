package app

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/redis"
)

func TestDBGetViewsFailsWhenAllViewMetadataQueriesFail(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{
		queryErr: errors.New("view metadata permission denied"),
	}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetViews(fixture.config, "CRH_AC")
	if result.Success || !result.Retryable {
		t.Fatalf("expected retryable view metadata failure, got %#v", result)
	}
	if !strings.Contains(result.Message, "view metadata permission denied") {
		t.Fatalf("expected view metadata error to propagate, got %q", result.Message)
	}
	views, ok := result.Data.([]map[string]string)
	if !ok || len(views) != 0 {
		t.Fatalf("expected no view data on failure, got %#v", result.Data)
	}
}

func TestDBGetViewsSucceedsWhenViewFallbackQuerySucceeds(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{
		queryResults: []fakeMetadataQueryResult{
			{match: "information_schema.tables", err: errors.New("catalog query denied")},
			{match: "SHOW FULL TABLES", rows: []map[string]interface{}{{
				"table_name": "active_users",
				"table_type": "VIEW",
			}}},
		},
	}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)
	config := fixture.config
	config.Type = "mysql"
	config.OceanBaseProtocol = ""
	config.Database = "app"

	result := fixture.app.DBGetViews(config, "app")
	if !result.Success || result.Retryable {
		t.Fatalf("expected successful fallback view metadata result, got %#v", result)
	}
	views, ok := result.Data.([]map[string]string)
	if !ok || len(views) != 1 || views[0]["View"] != "active_users" {
		t.Fatalf("expected fallback view metadata, got %#v", result.Data)
	}
}

func TestDBGetObjectsMarksExtensionMetadataFailuresPartial(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{
		tables:   []string{"CRH_AC.ORDERS"},
		queryErr: errors.New("metadata permission denied"),
	}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetObjects(fixture.config, "CRH_AC")
	if !result.Success || !result.Partial || !result.Retryable {
		t.Fatalf("expected retryable partial object metadata result, got %#v", result)
	}
	if !strings.Contains(strings.Join(result.FailedObjectTypes, ","), "view") {
		t.Fatalf("expected failed view metadata to be identified, got %#v", result.FailedObjectTypes)
	}
	if !strings.Contains(strings.Join(result.Warnings, "\n"), "metadata permission denied") {
		t.Fatalf("expected query error summary in warnings, got %#v", result.Warnings)
	}
	objects, ok := result.Data.([]connection.DatabaseObject)
	if !ok || len(objects) != 1 || objects[0].Name != "ORDERS" || objects[0].Type != "table" {
		t.Fatalf("expected discovered table to be retained, got %#v", result.Data)
	}
}

func TestDBGetObjectsFailsWhenBaseTableMetadataFails(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{tablesErr: errors.New("table metadata permission denied")}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetObjects(fixture.config, "CRH_AC")
	if result.Success || !result.Partial || !result.Retryable {
		t.Fatalf("expected retryable base metadata failure, got %#v", result)
	}
	if len(result.FailedObjectTypes) != 1 || result.FailedObjectTypes[0] != "table" {
		t.Fatalf("expected table failure type, got %#v", result.FailedObjectTypes)
	}
	if !strings.Contains(result.Message, "table metadata permission denied") {
		t.Fatalf("expected base error summary, got %q", result.Message)
	}
}

func TestDBGetObjectsMarksRedisKeyMetadataFailuresPartial(t *testing.T) {
	originalNewRedisClientFunc := newRedisClientFunc
	t.Cleanup(func() {
		newRedisClientFunc = originalNewRedisClientFunc
		CloseAllRedisClients()
	})
	CloseAllRedisClients()
	newRedisClientFunc = func() redis.RedisClient {
		return &capturingRedisClient{scanErr: errors.New("key scan denied")}
	}

	result := NewApp().DBGetObjects(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "0")
	if result.Success || !result.Partial || !result.Retryable {
		t.Fatalf("expected retryable Redis key metadata failure, got %#v", result)
	}
	if len(result.FailedObjectTypes) != 1 || result.FailedObjectTypes[0] != "key" {
		t.Fatalf("expected key failure type, got %#v", result.FailedObjectTypes)
	}
	if !strings.Contains(result.Message, "key scan denied") {
		t.Fatalf("expected key scan error summary, got %q", result.Message)
	}
}

func TestDBGetTablesRedisCursorState(t *testing.T) {
	testCases := []struct {
		name          string
		scanResults   []*redis.RedisScanResult
		wantKeys      int
		wantPartial   bool
		wantTruncated bool
		wantWarning   string
		wantScanCalls int
	}{
		{
			name: "invalid cursor",
			scanResults: []*redis.RedisScanResult{{
				Keys:   []redis.RedisKeyInfo{{Key: "orders"}},
				Cursor: "not-a-cursor",
			}},
			wantKeys:      1,
			wantPartial:   true,
			wantTruncated: true,
			wantWarning:   "invalid cursor",
		},
		{
			name: "repeated cursor",
			scanResults: []*redis.RedisScanResult{
				{Keys: []redis.RedisKeyInfo{{Key: "orders"}}, Cursor: "7"},
				{Keys: []redis.RedisKeyInfo{{Key: "users"}}, Cursor: "7"},
			},
			wantKeys:      2,
			wantPartial:   true,
			wantTruncated: true,
			wantWarning:   "cursor loop detected",
			wantScanCalls: 2,
		},
		{
			name: "cursor loop",
			scanResults: []*redis.RedisScanResult{
				{Keys: []redis.RedisKeyInfo{{Key: "orders"}}, Cursor: "7"},
				{Keys: []redis.RedisKeyInfo{{Key: "users"}}, Cursor: "8"},
				{Keys: []redis.RedisKeyInfo{{Key: "products"}}, Cursor: "7"},
			},
			wantKeys:      3,
			wantPartial:   true,
			wantTruncated: true,
			wantWarning:   "cursor loop detected",
			wantScanCalls: 3,
		},
		{
			name: "normal zero cursor",
			scanResults: []*redis.RedisScanResult{{
				Keys:   []redis.RedisKeyInfo{{Key: "orders"}},
				Cursor: "0",
			}},
			wantKeys: 1,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			originalNewRedisClientFunc := newRedisClientFunc
			t.Cleanup(func() {
				newRedisClientFunc = originalNewRedisClientFunc
				CloseAllRedisClients()
			})
			CloseAllRedisClients()
			client := &capturingRedisClient{scanResults: tc.scanResults}
			newRedisClientFunc = func() redis.RedisClient {
				return client
			}

			result := NewApp().DBGetTables(connection.ConnectionConfig{
				Type: "redis",
				Host: "redis-" + tc.name + ".local",
				Port: 6379,
			}, "0")
			if !result.Success {
				t.Fatalf("expected scan result, got failure: %#v", result)
			}
			rows, ok := result.Data.([]map[string]string)
			if !ok || len(rows) != tc.wantKeys {
				t.Fatalf("expected %d scanned keys, got %#v", tc.wantKeys, result.Data)
			}
			if result.Partial != tc.wantPartial || result.Truncated != tc.wantTruncated {
				t.Fatalf("unexpected cursor state: %#v", result)
			}
			if result.ScannedCount != tc.wantKeys {
				t.Fatalf("expected scannedCount=%d, got %d", tc.wantKeys, result.ScannedCount)
			}
			if tc.wantWarning != "" && !strings.Contains(strings.Join(result.Warnings, "\n"), tc.wantWarning) {
				t.Fatalf("expected warning containing %q, got %#v", tc.wantWarning, result.Warnings)
			}
			if tc.wantScanCalls > 0 && client.scanCalls != tc.wantScanCalls {
				t.Fatalf("expected %d scan calls, got %d", tc.wantScanCalls, client.scanCalls)
			}
		})
	}
}

func TestDBGetObjectsPreservesRedisCursorTruncation(t *testing.T) {
	originalNewRedisClientFunc := newRedisClientFunc
	t.Cleanup(func() {
		newRedisClientFunc = originalNewRedisClientFunc
		CloseAllRedisClients()
	})
	CloseAllRedisClients()
	newRedisClientFunc = func() redis.RedisClient {
		return &capturingRedisClient{scanResults: []*redis.RedisScanResult{{
			Keys:   []redis.RedisKeyInfo{{Key: "orders"}},
			Cursor: "invalid",
		}}}
	}

	result := NewApp().DBGetObjects(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis-object-cursor.local",
		Port: 6379,
	}, "0")
	if !result.Success || !result.Partial || !result.Truncated || !result.Retryable {
		t.Fatalf("expected partial Redis object result, got %#v", result)
	}
	if len(result.FailedObjectTypes) != 1 || result.FailedObjectTypes[0] != "key" {
		t.Fatalf("expected key failure type, got %#v", result.FailedObjectTypes)
	}
	if result.ScannedCount != 1 || !strings.Contains(result.Message, "invalid cursor") {
		t.Fatalf("expected cursor warning and count, got %#v", result)
	}
}
