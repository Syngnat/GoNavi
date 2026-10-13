package db

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestGetTableInfoUnsupportedDriver(t *testing.T) {
	queryFn := func(context.Context, string) ([]map[string]interface{}, error) {
		t.Fatal("不支持的驱动不应发起查询")
		return nil, nil
	}
	// GetTableInfo 需要 Database 才能构造 queryFn，因此这里直接断言方言分发函数的
	// 前置：用合法驱动类型与 nil 检查 + unsupported 驱动走 default 分支。
	_, err := dispatchTableInfoQuery(context.Background(), "oracle", "db", "", "t", queryFn)
	if !errors.Is(err, ErrTableInfoUnsupported) {
		t.Fatalf("oracle err = %v, want ErrTableInfoUnsupported", err)
	}
}

func TestGetTableInfoMySQLFamily(t *testing.T) {
	var capturedQuery string
	queryFn := func(_ context.Context, query string) ([]map[string]interface{}, error) {
		capturedQuery = query
		return []map[string]interface{}{{
			"ENGINE":            "InnoDB",
			"TABLE_COMMENT":     "订单主表",
			"TABLE_COLLATION":   "utf8mb4_general_ci",
			"ROW_FORMAT":        "Dynamic",
			"TABLE_ROWS":        "12345",
			"DATA_LENGTH":       int64(4096),
			"INDEX_LENGTH":      nil,
			"AUTO_INCREMENT":    "1001",
			"CREATE_TIME":       "2024-05-01 10:00:00",
			"UPDATE_TIME":       nil,
		}}, nil
	}
	details, err := dispatchTableInfoQuery(context.Background(), "mariadb", "shop", "", "orders", queryFn)
	if err != nil {
		t.Fatalf("mariadb err = %v", err)
	}
	if !strings.Contains(capturedQuery, "TABLE_SCHEMA = 'shop'") || !strings.Contains(capturedQuery, "TABLE_NAME = 'orders'") {
		t.Fatalf("query = %s, want schema/table filters", capturedQuery)
	}
	if details.Engine != "InnoDB" || details.Comment != "订单主表" || details.Collation != "utf8mb4_general_ci" || details.RowFormat != "Dynamic" {
		t.Fatalf("details = %+v", details)
	}
	if details.Rows == nil || *details.Rows != 12345 {
		t.Fatalf("rows = %v, want 12345", details.Rows)
	}
	if details.DataLength == nil || *details.DataLength != 4096 {
		t.Fatalf("dataLength = %v, want 4096", details.DataLength)
	}
	if details.IndexLength != nil {
		t.Fatalf("indexLength = %v, want nil", details.IndexLength)
	}
	if details.AutoIncrement != "1001" || details.CreateTime != "2024-05-01 10:00:00" || details.UpdateTime != "" {
		t.Fatalf("details = %+v", details)
	}
}

func TestGetTableInfoMySQLFamilyEscapesIdentifiers(t *testing.T) {
	var capturedQuery string
	queryFn := func(_ context.Context, query string) ([]map[string]interface{}, error) {
		capturedQuery = query
		return []map[string]interface{}{{"ENGINE": "InnoDB"}}, nil
	}
	if _, err := dispatchTableInfoQuery(context.Background(), "mysql", "sh'op", "", "or`ders", queryFn); err != nil {
		t.Fatalf("mysql err = %v", err)
	}
	// 单引号必须被转义成两个单引号；反引号在单引号字面量里无害，原样保留。
	if !strings.Contains(capturedQuery, "'sh''op'") {
		t.Fatalf("query = %s, want doubled quote", capturedQuery)
	}
}

func TestGetTableInfoMySQLFamilyMissingTable(t *testing.T) {
	queryFn := func(context.Context, string) ([]map[string]interface{}, error) {
		return nil, nil
	}
	if _, err := dispatchTableInfoQuery(context.Background(), "mysql", "shop", "", "missing", queryFn); err == nil {
		t.Fatal("missing table should error")
	}
}

func TestGetTableInfoPostgresFamily(t *testing.T) {
	var capturedQuery string
	queryFn := func(_ context.Context, query string) ([]map[string]interface{}, error) {
		capturedQuery = query
		return []map[string]interface{}{{
			"relkind":       "r",
			"est_rows":      "-1",
			"data_length":   "8192",
			"index_length":  "4096",
			"table_comment": "客户表",
			"collation":     "en_US.UTF-8",
		}}, nil
	}
	details, err := dispatchTableInfoQuery(context.Background(), "kingbase", "app", "sales", "customers", queryFn)
	if err != nil {
		t.Fatalf("kingbase err = %v", err)
	}
	if !strings.Contains(capturedQuery, "nspname = 'sales'") {
		t.Fatalf("query = %s, want schema filter", capturedQuery)
	}
	if details.Engine != "heap" || details.Comment != "客户表" || details.Collation != "en_US.UTF-8" {
		t.Fatalf("details = %+v", details)
	}
	if details.Rows != nil {
		t.Fatalf("rows = %v, want nil for reltuples=-1", details.Rows)
	}
	if details.DataLength == nil || *details.DataLength != 8192 || details.IndexLength == nil || *details.IndexLength != 4096 {
		t.Fatalf("details = %+v", details)
	}
}

func TestGetTableInfoPostgresDefaultsToPublicSchema(t *testing.T) {
	var capturedQuery string
	queryFn := func(_ context.Context, query string) ([]map[string]interface{}, error) {
		capturedQuery = query
		return []map[string]interface{}{{"relkind": "p"}}, nil
	}
	details, err := dispatchTableInfoQuery(context.Background(), "postgres", "app", "", "events", queryFn)
	if err != nil {
		t.Fatalf("postgres err = %v", err)
	}
	if !strings.Contains(capturedQuery, "nspname = 'public'") {
		t.Fatalf("query = %s, want public schema fallback", capturedQuery)
	}
	if details.Engine != "partitioned table" {
		t.Fatalf("engine = %s, want partitioned table", details.Engine)
	}
}

func TestGetTableInfoSQLite(t *testing.T) {
	queries := make([]string, 0, 2)
	queryFn := func(_ context.Context, query string) ([]map[string]interface{}, error) {
		queries = append(queries, query)
		if strings.Contains(query, "page_count") {
			return []map[string]interface{}{{"page_count": "512"}}, nil
		}
		return []map[string]interface{}{{"page_size": "4096"}}, nil
	}
	details, err := dispatchTableInfoQuery(context.Background(), "sqlite", "", "", "t", queryFn)
	if err != nil {
		t.Fatalf("sqlite err = %v", err)
	}
	if details.Engine != "SQLite" {
		t.Fatalf("engine = %s, want SQLite", details.Engine)
	}
	if details.DataLength == nil || *details.DataLength != 512*4096 {
		t.Fatalf("dataLength = %v, want %d", details.DataLength, 512*4096)
	}
	if len(queries) != 2 {
		t.Fatalf("queries = %v, want two pragma queries", queries)
	}
}

func TestGetTableInfoNilDatabase(t *testing.T) {
	if _, err := GetTableInfo(context.Background(), nil, "mysql", "db", "", "t"); err == nil {
		t.Fatal("nil database should error")
	}
}
