package mcpserver

import (
	"context"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestGetTablesForwardsCancellationWithoutAffectingConcurrentRequests(t *testing.T) {
	backend := &cancellableTablesBackend{
		fakeBackend: &fakeBackend{
			editableConnection: connection.SavedConnectionView{
				ID:     "mysql-main",
				Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
			},
			tablesResult: connection.QueryResult{
				Success: true,
				Data:    []map[string]string{{"Table": "users"}},
			},
		},
		started: make(chan struct{}, 1),
	}
	service := NewService(backend)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type callResult struct {
		result *mcp.CallToolResult
		output getTablesResult
		err    error
	}
	firstResult := make(chan callResult, 1)
	go func() {
		result, output, err := service.GetTables(ctx, nil, databaseArgs{ConnectionID: "mysql-main", DBName: "app"})
		firstResult <- callResult{result: result, output: output, err: err}
	}()

	select {
	case <-backend.started:
	case <-time.After(2 * time.Second):
		t.Fatal("GetTables did not reach the cancellable backend")
	}

	secondResult, secondOutput, secondErr := service.GetTables(context.Background(), nil, databaseArgs{ConnectionID: "mysql-main", DBName: "app"})
	if secondErr != nil || secondResult == nil || secondResult.IsError {
		t.Fatalf("concurrent GetTables failed: result=%#v err=%v", secondResult, secondErr)
	}
	if len(secondOutput.Tables) != 1 || secondOutput.Tables[0] != "users" {
		t.Fatalf("unexpected concurrent GetTables output: %#v", secondOutput)
	}

	cancel()
	select {
	case received := <-firstResult:
		if received.err != nil {
			t.Fatalf("cancelled GetTables returned transport error: %v", received.err)
		}
		if received.result == nil || !received.result.IsError {
			t.Fatalf("cancelled GetTables should return a tool error, got %#v", received.result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled GetTables did not return")
	}
}

func TestGetTablesReturnsCancellationWhenViewLookupIsCancelled(t *testing.T) {
	backend := &cancellableViewsBackend{
		fakeBackend: &fakeBackend{
			editableConnection: connection.SavedConnectionView{
				ID:     "mysql-main",
				Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
			},
			tablesResult: connection.QueryResult{
				Success: true,
				Data:    []map[string]string{{"Table": "users"}},
			},
		},
		started: make(chan struct{}, 1),
	}
	service := NewService(backend)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type callResult struct {
		result *mcp.CallToolResult
		output getTablesResult
		err    error
	}
	results := make(chan callResult, 1)
	go func() {
		result, output, err := service.GetTables(ctx, nil, databaseArgs{ConnectionID: "mysql-main", DBName: "app"})
		results <- callResult{result: result, output: output, err: err}
	}()

	select {
	case <-backend.started:
	case <-time.After(2 * time.Second):
		t.Fatal("GetTables did not reach the cancellable view lookup")
	}
	cancel()

	select {
	case received := <-results:
		if received.err != nil {
			t.Fatalf("cancelled GetTables returned transport error: %v", received.err)
		}
		if received.result == nil || !received.result.IsError {
			t.Fatalf("cancelled view lookup should return a tool error, got %#v", received.result)
		}
		if len(received.output.Tables) != 0 || len(received.output.Views) != 0 {
			t.Fatalf("cancelled view lookup returned partial metadata: %#v", received.output)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled view lookup did not return")
	}
}

func TestGetColumnsForwardsCancellation(t *testing.T) {
	backend := &cancellableColumnsBackend{
		fakeBackend: &fakeBackend{
			editableConnection: connection.SavedConnectionView{
				ID:     "mysql-main",
				Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
			},
		},
		started: make(chan struct{}, 1),
	}
	service := NewService(backend)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type callResult struct {
		result *mcp.CallToolResult
		output getColumnsResult
		err    error
	}
	results := make(chan callResult, 1)
	go func() {
		result, output, err := service.GetColumns(ctx, nil, tableArgs{ConnectionID: "mysql-main", DBName: "app", TableName: "orders"})
		results <- callResult{result: result, output: output, err: err}
	}()

	select {
	case <-backend.started:
	case <-time.After(2 * time.Second):
		t.Fatal("GetColumns 未到达可取消后端")
	}
	cancel()

	select {
	case received := <-results:
		if received.err != nil {
			t.Fatalf("取消的 GetColumns 返回传输错误：%v", received.err)
		}
		if received.result == nil || !received.result.IsError {
			t.Fatalf("取消的 GetColumns 应返回工具错误，实际为 %#v", received.result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消的 GetColumns 未返回")
	}
}

func TestGetConnectionsReturnsSavedConnectionSummaries(t *testing.T) {
	backend := &fakeBackend{
		savedConnections: []connection.SavedConnectionView{
			{
				ID:   "mysql-main",
				Name: "MySQL Main",
				Config: connection.ConnectionConfig{
					Type:     "mysql",
					Host:     "10.0.0.8",
					Port:     3306,
					Database: "app",
					UseSSH:   true,
				},
			},
			{
				ID:   "duckdb-local",
				Name: "DuckDB Local",
				Config: connection.ConnectionConfig{
					Type:     "duckdb",
					Database: `C:\data\example.duckdb`,
				},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetConnections(context.Background(), nil, emptyArgs{})
	if err != nil {
		t.Fatalf("GetConnections returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.Connections) != 2 {
		t.Fatalf("expected 2 connections, got %d", len(out.Connections))
	}
	if out.Connections[0].Target != "10.0.0.8:3306" {
		t.Fatalf("unexpected mysql target: %q", out.Connections[0].Target)
	}
	if out.Connections[1].Target != `C:\data\example.duckdb` {
		t.Fatalf("unexpected duckdb target: %q", out.Connections[1].Target)
	}
}

func TestGetConnectionsRedactsOpaqueURIAndDSNTargets(t *testing.T) {
	backend := &fakeBackend{
		savedConnections: []connection.SavedConnectionView{
			{
				ID:   "pg-uri",
				Name: "Postgres URI",
				Config: connection.ConnectionConfig{
					Type: "postgres",
					URI:  "postgres://postgres:secret@db.local:5432/app?sslmode=disable",
				},
			},
			{
				ID:   "mysql-dsn",
				Name: "MySQL DSN",
				Config: connection.ConnectionConfig{
					Type: "mysql",
					DSN:  "root:secret@tcp(db.local:3306)/app?charset=utf8mb4",
				},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetConnections(context.Background(), nil, emptyArgs{})
	if err != nil {
		t.Fatalf("GetConnections returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.Connections) != 2 {
		t.Fatalf("expected 2 connections, got %d", len(out.Connections))
	}
	if out.Connections[0].Target != "postgres://db.local:5432/app" {
		t.Fatalf("expected URI target to remove credentials and query, got %q", out.Connections[0].Target)
	}
	if strings.Contains(out.Connections[0].Target, "secret") || strings.Contains(out.Connections[0].Target, "postgres@") {
		t.Fatalf("URI target leaked credentials: %q", out.Connections[0].Target)
	}
	if out.Connections[1].Target != redactedOpaqueTarget {
		t.Fatalf("expected opaque DSN target to be redacted, got %q", out.Connections[1].Target)
	}
}

func TestGetAllColumnsReturnsCrossTableColumnSummaries(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		allColumnsResult: connection.QueryResult{
			Success: true,
			Data: []connection.ColumnDefinitionWithTable{
				{TableName: "users", Name: "email", Type: "varchar(255)", Comment: "用户邮箱"},
				{TableName: "orders", Name: "user_id", Type: "bigint", Comment: "关联用户"},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetAllColumns(context.Background(), nil, databaseArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
	})
	if err != nil {
		t.Fatalf("GetAllColumns returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.Columns) != 2 || out.Columns[0].TableName != "users" || out.Columns[1].Name != "user_id" {
		t.Fatalf("unexpected all columns output: %#v", out)
	}
}

func TestGetAllColumnsPreservesPartialMetadataWarnings(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		allColumnsResult: connection.QueryResult{
			Success:  true,
			Partial:  true,
			Message:  "Column summary is incomplete",
			Warnings: []string{"Failed to read column metadata for restricted: permission denied"},
			Data: []connection.ColumnDefinitionWithTable{
				{TableName: "healthy", Name: "id", Type: "bigint"},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetAllColumns(context.Background(), nil, databaseArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
	})
	if err != nil {
		t.Fatalf("GetAllColumns returned error: %v", err)
	}
	if result == nil || result.IsError || !out.Partial {
		t.Fatalf("expected partial success result, got %#v / %#v", result, out)
	}
	if len(out.Columns) != 1 || out.Columns[0].TableName != "healthy" {
		t.Fatalf("expected successful columns, got %#v", out.Columns)
	}
	if out.Message != "Column summary is incomplete" || len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], "restricted") {
		t.Fatalf("expected partial metadata details, got %#v", out)
	}
}

func TestGetViewsReturnsViewNames(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		viewsResult: connection.QueryResult{
			Success: true,
			Data: []map[string]string{
				{"View": "active_users"},
				{"View": "reporting.monthly_orders"},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetViews(context.Background(), nil, databaseArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
	})
	if err != nil {
		t.Fatalf("GetViews returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.Views) != 2 || out.Views[0] != "active_users" || out.Views[1] != "reporting.monthly_orders" {
		t.Fatalf("unexpected views output: %#v", out)
	}
}

func TestGetTablesIncludesViewsInDedicatedField(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		tablesResult: connection.QueryResult{
			Success: true,
			Data: []map[string]string{
				{"Table": "users"},
			},
		},
		viewsResult: connection.QueryResult{
			Success: true,
			Data: []map[string]string{
				{"View": "active_users"},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetTables(context.Background(), nil, databaseArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
	})
	if err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.Tables) != 1 || out.Tables[0] != "users" {
		t.Fatalf("unexpected tables output: %#v", out)
	}
	if len(out.Views) != 1 || out.Views[0] != "active_users" {
		t.Fatalf("expected GetTables to expose views separately, got %#v", out)
	}
	if out.Partial || len(out.Warnings) != 0 {
		t.Fatalf("expected complete table metadata result, got %#v", out)
	}
}

func TestGetTablesMarksViewReadFailurePartial(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		tablesResult: connection.QueryResult{
			Success: true,
			Data:    []map[string]string{{"Table": "users"}},
		},
		viewsResult: connection.QueryResult{
			Success:   false,
			Message:   "authentication failed password=secret-token",
			Retryable: true,
		},
	}

	result, out, err := NewService(backend).GetTables(context.Background(), nil, databaseArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
	})
	if err != nil || result == nil || result.IsError {
		t.Fatalf("expected partial table metadata success, result=%#v err=%v", result, err)
	}
	if !out.Partial || !out.Retryable || len(out.Views) != 0 || len(out.Warnings) != 1 {
		t.Fatalf("view lookup failure was not represented as partial metadata: %#v", out)
	}
	if out.Warnings[0] != "获取视图元数据失败，返回的对象集合不完整" {
		t.Fatalf("expected safe view metadata warning, got %#v", out.Warnings)
	}
	if strings.Contains(out.Message, "secret-token") || strings.Contains(out.Warnings[0], "secret-token") {
		t.Fatalf("view metadata failure leaked sensitive detail: %#v", out)
	}
}

func TestGetTablesMarksViewDecodeFailurePartial(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		tablesResult: connection.QueryResult{
			Success: true,
			Data:    []map[string]string{{"Table": "users"}},
		},
		viewsResult: connection.QueryResult{
			Success: true,
			Data:    []int{1},
		},
	}

	result, out, err := NewService(backend).GetTables(context.Background(), nil, databaseArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
	})
	if err != nil || result == nil || result.IsError {
		t.Fatalf("expected partial table metadata success, result=%#v err=%v", result, err)
	}
	if !out.Partial || len(out.Views) != 0 || len(out.Warnings) != 1 {
		t.Fatalf("view decode failure was not represented as partial metadata: %#v", out)
	}
	if out.Warnings[0] != "获取视图元数据失败，返回的对象集合不完整" {
		t.Fatalf("expected safe view metadata warning, got %#v", out.Warnings)
	}
}

func TestGetTablesPreservesPartialMetadataWarnings(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "redis-main",
			Config: connection.ConnectionConfig{Type: "redis", Database: "0"},
		},
		tablesResult: connection.QueryResult{
			Success:      true,
			Message:      "Redis key scan truncated after 2 keys: cursor loop detected",
			Partial:      true,
			Truncated:    true,
			Retryable:    true,
			ScannedCount: 2,
			Warnings:     []string{"Redis key scan truncated after 2 keys: cursor loop detected"},
			Data:         []map[string]string{{"Table": "orders"}, {"Table": "users"}},
		},
		viewsResult: connection.QueryResult{Success: true},
	}

	result, out, err := NewService(backend).GetTables(context.Background(), nil, databaseArgs{
		ConnectionID: "redis-main",
		DBName:       "0",
	})
	if err != nil || result == nil || result.IsError {
		t.Fatalf("expected partial table metadata success, result=%#v err=%v", result, err)
	}
	if !out.Partial || !out.Truncated || !out.Retryable || out.ScannedCount != 2 || len(out.Warnings) != 1 {
		t.Fatalf("partial table metadata details were lost: %#v", out)
	}
	if out.Message != backend.tablesResult.Message || out.Warnings[0] != backend.tablesResult.Warnings[0] {
		t.Fatalf("expected table metadata message and warnings to propagate, got %#v", out)
	}
}

func TestGetObjectsReturnsDatabaseObjectsAndFiltersByType(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		objectsResult: connection.QueryResult{
			Success: true,
			Data: []connection.DatabaseObject{
				{Database: "app", Name: "users", Type: "table"},
				{Database: "app", Name: "active_users", Type: "view"},
				{Database: "app", Schema: "public", Name: "refresh_cache", Type: "function"},
				{Database: "app", Name: "orders.events", Type: "queue"},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetObjects(context.Background(), nil, objectsArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
		ObjectTypes:  []string{"function", "queues"},
	})
	if err != nil {
		t.Fatalf("GetObjects returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.Objects) != 2 {
		t.Fatalf("expected 2 filtered objects, got %#v", out.Objects)
	}
	if out.Objects[0].Type != "function" || out.Objects[1].Type != "queue" {
		t.Fatalf("unexpected filtered objects: %#v", out.Objects)
	}
	if out.Objects[1].Name != "orders.events" {
		t.Fatalf("queue names must preserve dots, got %#v", out.Objects[1])
	}
}

func TestGetObjectsPreservesPartialMetadataWarnings(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID:     "mysql-main",
			Config: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		},
		objectsResult: connection.QueryResult{
			Success:           true,
			Partial:           true,
			Retryable:         true,
			Truncated:         true,
			ScannedCount:      1,
			Warnings:          []string{"读取 view 对象元数据失败: permission denied"},
			FailedObjectTypes: []string{"view"},
			Data:              []connection.DatabaseObject{{Database: "app", Name: "users", Type: "table"}},
		},
	}

	result, out, err := NewService(backend).GetObjects(context.Background(), nil, objectsArgs{ConnectionID: "mysql-main", DBName: "app"})
	if err != nil || result == nil || result.IsError {
		t.Fatalf("expected partial metadata success, result=%#v err=%v", result, err)
	}
	if !out.Partial || !out.Retryable || !out.Truncated || out.ScannedCount != 1 || len(out.Warnings) != 1 || len(out.FailedObjectTypes) != 1 || out.FailedObjectTypes[0] != "view" {
		t.Fatalf("partial metadata details were lost: %#v", out)
	}
}

func TestGetObjectsMarksBaseMetadataFailureRetryable(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{ID: "mysql-main", Config: connection.ConnectionConfig{Type: "mysql", Database: "app"}},
		objectsResult: connection.QueryResult{
			Success:           false,
			Partial:           true,
			Retryable:         true,
			Message:           "读取 table 对象元数据失败: permission denied",
			FailedObjectTypes: []string{"table"},
		},
	}

	result, out, err := NewService(backend).GetObjects(context.Background(), nil, objectsArgs{ConnectionID: "mysql-main", DBName: "app"})
	if err != nil || result == nil || !result.IsError {
		t.Fatalf("expected retryable tool error, result=%#v err=%v", result, err)
	}
	text := firstTextContent(result)
	if !strings.Contains(text, "table") || !strings.Contains(text, "可重试") {
		t.Fatalf("expected failure category and retry guidance, got %q", text)
	}
	if !out.Partial || !out.Retryable || len(out.Warnings) != 1 || len(out.FailedObjectTypes) != 1 || out.FailedObjectTypes[0] != "table" {
		t.Fatalf("expected structured retry metadata, got %#v", out)
	}
}

func TestGetIndexesReturnsIndexDefinitions(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		indexesResult: connection.QueryResult{
			Success: true,
			Data: []connection.IndexDefinition{
				{Name: "idx_users_email", ColumnName: "email", NonUnique: 0, SeqInIndex: 1, IndexType: "BTREE"},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetIndexes(context.Background(), nil, tableArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
		TableName:    "users",
	})
	if err != nil {
		t.Fatalf("GetIndexes returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.Indexes) != 1 || out.Indexes[0].Name != "idx_users_email" {
		t.Fatalf("unexpected indexes output: %#v", out)
	}
}

func TestGetForeignKeysReturnsForeignKeyDefinitions(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		foreignKeysResult: connection.QueryResult{
			Success: true,
			Data: []connection.ForeignKeyDefinition{
				{Name: "fk_orders_user_id", ColumnName: "user_id", RefTableName: "users", RefColumnName: "id", ConstraintName: "fk_orders_user_id"},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetForeignKeys(context.Background(), nil, tableArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
		TableName:    "orders",
	})
	if err != nil {
		t.Fatalf("GetForeignKeys returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.ForeignKeys) != 1 || out.ForeignKeys[0].RefTableName != "users" {
		t.Fatalf("unexpected foreign keys output: %#v", out)
	}
}

func TestGetTriggersReturnsTriggerDefinitions(t *testing.T) {
	backend := &fakeBackend{
		editableConnection: connection.SavedConnectionView{
			ID: "mysql-main",
			Config: connection.ConnectionConfig{
				Type:     "mysql",
				Database: "app",
			},
		},
		triggersResult: connection.QueryResult{
			Success: true,
			Data: []connection.TriggerDefinition{
				{Name: "trg_orders_audit", Timing: "AFTER", Event: "INSERT", Statement: "INSERT INTO audit_log ..."},
			},
		},
	}

	service := NewService(backend)
	result, out, err := service.GetTriggers(context.Background(), nil, tableArgs{
		ConnectionID: "mysql-main",
		DBName:       "app",
		TableName:    "orders",
	})
	if err != nil {
		t.Fatalf("GetTriggers returned error: %v", err)
	}
	if result == nil || result.IsError {
		t.Fatalf("expected success result, got %#v", result)
	}
	if len(out.Triggers) != 1 || out.Triggers[0].Name != "trg_orders_audit" {
		t.Fatalf("unexpected triggers output: %#v", out)
	}
}
