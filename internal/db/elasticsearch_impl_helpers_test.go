//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestNormalizeElasticsearchConfig 测试配置规范化。
func TestNormalizeElasticsearchConfig(t *testing.T) {
	t.Run("设置默认值", func(t *testing.T) {
		config := normalizeElasticsearchConfig(connection.ConnectionConfig{
			Type: "elasticsearch",
		})
		if config.Host != "localhost" {
			t.Fatalf("默认 Host 期望 localhost，实际：%q", config.Host)
		}
		if config.Port != defaultEsPort {
			t.Fatalf("默认 Port 期望 %d，实际：%d", defaultEsPort, config.Port)
		}
		if config.User != "" {
			t.Fatalf("默认 User 期望空字符串，实际：%q", config.User)
		}
	})

	t.Run("保留用户设置", func(t *testing.T) {
		config := normalizeElasticsearchConfig(connection.ConnectionConfig{
			Type:     "elasticsearch",
			Host:     "es.example.com",
			Port:     9201,
			User:     "admin",
			Password: "secret",
		})
		if config.Host != "es.example.com" {
			t.Fatalf("Host 期望 es.example.com，实际：%q", config.Host)
		}
		if config.Port != 9201 {
			t.Fatalf("Port 期望 9201，实际：%d", config.Port)
		}
		if config.User != "admin" {
			t.Fatalf("User 期望 admin，实际：%q", config.User)
		}
	})

	t.Run("从 URI 中提取配置", func(t *testing.T) {
		config := normalizeElasticsearchConfig(connection.ConnectionConfig{
			Type: "elasticsearch",
			URI:  "http://uri-user:uri-pass@es-host:9202",
		})
		if config.User != "uri-user" {
			t.Fatalf("User 期望从 URI 提取 uri-user，实际：%q", config.User)
		}
		if config.Password != "uri-pass" {
			t.Fatalf("Password 期望从 URI 提取 uri-pass，实际：%q", config.Password)
		}
		if config.Host != "es-host" {
			t.Fatalf("Host 期望从 URI 提取 es-host，实际：%q", config.Host)
		}
		if config.Port != 9202 {
			t.Fatalf("Port 期望从 URI 提取 9202，实际：%d", config.Port)
		}
	})

	t.Run("已有 Host 时不从 URI 覆盖", func(t *testing.T) {
		config := normalizeElasticsearchConfig(connection.ConnectionConfig{
			Type: "elasticsearch",
			Host: "custom-host",
			URI:  "http://uri-user:uri-pass@uri-host:9200",
		})
		if config.Host != "custom-host" {
			t.Fatalf("已有 Host 时不应覆盖，期望 custom-host，实际：%q", config.Host)
		}
	})
}

// TestApplyElasticsearchURI 测试 URI 解析。
func TestApplyElasticsearchURI(t *testing.T) {
	t.Run("HTTPS URI 启用 SSL", func(t *testing.T) {
		config := applyElasticsearchURI(connection.ConnectionConfig{
			URI: "https://user:pass@es.example.com:9200",
		})
		if !config.UseSSL {
			t.Fatal("HTTPS URI 应启用 SSL")
		}
		if config.SSLMode != "required" {
			t.Fatalf("SSLMode 期望 required，实际：%q", config.SSLMode)
		}
		if config.Host != "es.example.com" {
			t.Fatalf("Host 期望 es.example.com，实际：%q", config.Host)
		}
	})

	t.Run("非 HTTP 协议忽略", func(t *testing.T) {
		config := applyElasticsearchURI(connection.ConnectionConfig{
			URI: "tcp://localhost:9200",
		})
		if config.Host != "" {
			t.Fatalf("非 HTTP 协议不应设置 Host，实际：%q", config.Host)
		}
	})

	t.Run("空 URI 不修改配置", func(t *testing.T) {
		config := applyElasticsearchURI(connection.ConnectionConfig{
			Host: "original-host",
			Port: 9300,
		})
		if config.Host != "original-host" || config.Port != 9300 {
			t.Fatal("空 URI 不应修改原有配置")
		}
	})

	t.Run("已有用户凭证不被 URI 覆盖", func(t *testing.T) {
		config := applyElasticsearchURI(connection.ConnectionConfig{
			User:     "existing-user",
			Password: "existing-pass",
			URI:      "http://uri-user:uri-pass@localhost:9200",
		})
		if config.User != "existing-user" {
			t.Fatalf("已有 User 不应覆盖，期望 existing-user，实际：%q", config.User)
		}
		if config.Password != "existing-pass" {
			t.Fatalf("已有 Password 不应覆盖，期望 existing-pass，实际：%q", config.Password)
		}
	})
}

// TestExtractColumnsFromMapping 测试 mapping 字段提取。
func TestExtractColumnsFromMapping(t *testing.T) {
	t.Run("标准字段提取", func(t *testing.T) {
		mapping := map[string]interface{}{
			"test-index": map[string]interface{}{
				"mappings": map[string]interface{}{
					"properties": map[string]interface{}{
						"title": map[string]interface{}{"type": "text"},
						"count": map[string]interface{}{"type": "long"},
						"tags":  map[string]interface{}{"type": "keyword"},
					},
				},
			},
		}

		columns := extractColumnsFromMapping("test-index", mapping)
		if len(columns) != 4 {
			t.Fatalf("期望 4 个字段（含 _id），实际 %d", len(columns))
		}

		typeMap := make(map[string]string)
		for _, col := range columns {
			typeMap[col.Name] = col.Type
		}
		expectedTypes := map[string]string{"_id": "keyword", "title": "text", "count": "long", "tags": "keyword"}
		for name, expectedType := range expectedTypes {
			if typeMap[name] != expectedType {
				t.Fatalf("字段 %q 类型期望 %q，实际 %q", name, expectedType, typeMap[name])
			}
		}
	})

	t.Run("含 description 的字段提取注释", func(t *testing.T) {
		mapping := map[string]interface{}{
			"idx": map[string]interface{}{
				"mappings": map[string]interface{}{
					"properties": map[string]interface{}{
						"email": map[string]interface{}{
							"type":        "keyword",
							"description": "用户邮箱地址",
						},
					},
				},
			},
		}

		columns := extractColumnsFromMapping("idx", mapping)
		if len(columns) != 2 {
			t.Fatalf("期望 2 个字段（含 _id），实际 %d", len(columns))
		}
		var emailComment string
		for _, col := range columns {
			if col.Name == "email" {
				emailComment = col.Comment
				break
			}
		}
		if emailComment != "用户邮箱地址" {
			t.Fatalf("期望 email 注释 '用户邮箱地址'，实际：%q", emailComment)
		}
	})

	t.Run("空 mapping 返回空列表", func(t *testing.T) {
		mapping := map[string]interface{}{}
		columns := extractColumnsFromMapping("non-existent", mapping)
		if len(columns) != 0 {
			t.Fatalf("空 mapping 应返回空列表，实际 %d 个", len(columns))
		}
	})

	t.Run("索引数据无 mappings 字段", func(t *testing.T) {
		mapping := map[string]interface{}{
			"idx": map[string]interface{}{
				"settings": map[string]interface{}{},
			},
		}
		columns := extractColumnsFromMapping("idx", mapping)
		if len(columns) != 0 {
			t.Fatalf("无 mappings 时应返回空列表，实际 %d 个", len(columns))
		}
	})

	t.Run("从 mapping 响应中自动查找索引数据", func(t *testing.T) {
		// 模拟 ES 返回的 mapping 响应，键名不完全匹配（如带日期后缀的索引别名）
		mapping := map[string]interface{}{
			"logs-2024.01.01": map[string]interface{}{
				"mappings": map[string]interface{}{
					"properties": map[string]interface{}{
						"message": map[string]interface{}{"type": "text"},
					},
				},
			},
		}
		columns := extractColumnsFromMapping("non-matching-key", mapping)
		if len(columns) != 2 {
			t.Fatalf("应自动查找 mapping 数据，期望 2 个字段（含 _id），实际 %d 个", len(columns))
		}
	})
}

// TestIsJSONDSL 测试 JSON DSL 检测。
func TestIsJSONDSL(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected bool
	}{
		{"JSON DSL", `{"query":{"match_all":{}}}`, true},
		{"简单字符串", "hello world", false},
		{"空字符串", "", false},
		{"JSON 对象以空格开头", `  {"query":{}}`, true},
		{"非查询 JSON 前缀", `[1,2,3]`, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isJSONDSL(tt.input); got != tt.expected {
				t.Fatalf("isJSONDSL(%q) = %v，期望 %v", tt.input, got, tt.expected)
			}
		})
	}
}

// TestExtractEsFieldType 测试字段类型提取。
func TestExtractEsFieldType(t *testing.T) {
	tests := []struct {
		name     string
		prop     interface{}
		expected string
	}{
		{
			name:     "标准字段类型",
			prop:     map[string]interface{}{"type": "keyword"},
			expected: "keyword",
		},
		{
			name:     "嵌套对象类型",
			prop:     map[string]interface{}{"properties": map[string]interface{}{}},
			expected: "object",
		},
		{
			name:     "无 type 无 properties",
			prop:     map[string]interface{}{"enabled": true},
			expected: "unknown",
		},
		{
			name:     "非 map 类型",
			prop:     "invalid",
			expected: "unknown",
		},
		{
			name:     "nil 值",
			prop:     nil,
			expected: "unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractEsFieldType(tt.prop); got != tt.expected {
				t.Fatalf("extractEsFieldType() = %q，期望 %q", got, tt.expected)
			}
		})
	}
}

// TestResolveEsIndexName 测试索引名解析。
func TestResolveEsIndexName(t *testing.T) {
	tests := []struct {
		name      string
		dbName    string
		tableName string
		defaultDB string
		expected  string
	}{
		{
			name:      "优先使用 tableName",
			dbName:    "db1",
			tableName: "tbl1",
			defaultDB: "default",
			expected:  "tbl1",
		},
		{
			name:      "回退到 dbName",
			dbName:    "db1",
			tableName: "",
			defaultDB: "default",
			expected:  "db1",
		},
		{
			name:      "回退到默认值",
			dbName:    "",
			tableName: "",
			defaultDB: "default",
			expected:  "default",
		},
		{
			name:      "全部为空",
			dbName:    "",
			tableName: "",
			defaultDB: "",
			expected:  "",
		},
		{
			name:      "空白字符等同于空",
			dbName:    "  ",
			tableName: "  ",
			defaultDB: "default",
			expected:  "default",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveEsIndexName(tt.dbName, tt.tableName, tt.defaultDB)
			if got != tt.expected {
				t.Fatalf("resolveEsIndexName(%q, %q, %q) = %q，期望 %q",
					tt.dbName, tt.tableName, tt.defaultDB, got, tt.expected)
			}
		})
	}
}

// TestParseESConsoleRequest 测试 DevTools 风格查询解析。
func TestParseESConsoleRequest(t *testing.T) {
	t.Run("带 body 的 GET 请求", func(t *testing.T) {
		input := "GET /logs-*/_search\n{\"query\":{\"match_all\":{}}}"
		req, ok := parseESConsoleRequest(input)
		if !ok {
			t.Fatal("解析应成功")
		}
		if req.Method != "GET" {
			t.Fatalf("方法期望 GET，实际：%q", req.Method)
		}
		if req.Path != "/logs-*/_search" {
			t.Fatalf("路径期望 /logs-*/_search，实际：%q", req.Path)
		}
		if len(req.Body) == 0 {
			t.Fatal("body 不应为空")
		}
	})

	t.Run("带 body 的 POST 请求", func(t *testing.T) {
		input := "POST /orders/_search\n{\"size\":10}"
		req, ok := parseESConsoleRequest(input)
		if !ok {
			t.Fatal("解析应成功")
		}
		if req.Method != "POST" {
			t.Fatalf("方法期望 POST，实际：%q", req.Method)
		}
		if req.Path != "/orders/_search" {
			t.Fatalf("路径期望 /orders/_search，实际：%q", req.Path)
		}
		if len(req.Body) == 0 {
			t.Fatal("body 不应为空")
		}
	})

	t.Run("无 body 的 GET 请求", func(t *testing.T) {
		input := "GET /_cluster/health"
		req, ok := parseESConsoleRequest(input)
		if !ok {
			t.Fatal("解析应成功")
		}
		if req.Method != "GET" {
			t.Fatalf("方法期望 GET，实际：%q", req.Method)
		}
		if req.Path != "/_cluster/health" {
			t.Fatalf("路径期望 /_cluster/health，实际：%q", req.Path)
		}
		if len(req.Body) != 0 {
			t.Fatalf("无 body 时应为空，实际长度：%d", len(req.Body))
		}
	})

	t.Run("DELETE 方法应被拒绝", func(t *testing.T) {
		input := "DELETE /index"
		_, ok := parseESConsoleRequest(input)
		if ok {
			t.Fatal("DELETE 请求应解析失败")
		}
	})

	t.Run("纯 JSON 应被拒绝", func(t *testing.T) {
		input := "{\"query\":{\"match_all\":{}}}"
		_, ok := parseESConsoleRequest(input)
		if ok {
			t.Fatal("纯 JSON 不是 DevTools 格式，应解析失败")
		}
	})

	t.Run("SQL 语句应被拒绝", func(t *testing.T) {
		input := "select * from test"
		_, ok := parseESConsoleRequest(input)
		if ok {
			t.Fatal("SQL 语句不是 DevTools 格式，应解析失败")
		}
	})
}

// TestFlattenESSource 测试嵌套对象展开为点分路径。
func TestFlattenESSource(t *testing.T) {
	t.Run("嵌套对象展开", func(t *testing.T) {
		source := map[string]interface{}{
			"user": map[string]interface{}{
				"name": "张三",
				"age":  18,
			},
		}
		row := make(map[string]interface{})
		flattenESSource("", source, row)

		if row["user.name"] != "张三" {
			t.Fatalf("user.name 期望 张三，实际：%v", row["user.name"])
		}
		if row["user.age"] != 18 {
			t.Fatalf("user.age 期望 18，实际：%v", row["user.age"])
		}
		// 原始嵌套键不应保留
		if _, ok := row["user"]; ok {
			t.Fatal("展开后不应保留原始嵌套键 user")
		}
	})

	t.Run("数组序列化为 JSON 字符串", func(t *testing.T) {
		source := map[string]interface{}{
			"tags": []interface{}{"a", "b"},
		}
		row := make(map[string]interface{})
		flattenESSource("", source, row)

		tags, ok := row["tags"].(string)
		if !ok {
			t.Fatalf("tags 应序列化为 JSON 字符串，实际类型：%T", row["tags"])
		}
		if tags != `["a","b"]` {
			t.Fatalf("tags JSON 不匹配，实际：%v", tags)
		}
	})

	t.Run("多层嵌套展开", func(t *testing.T) {
		source := map[string]interface{}{
			"a": map[string]interface{}{
				"b": map[string]interface{}{
					"c": 1,
				},
			},
		}
		row := make(map[string]interface{})
		flattenESSource("", source, row)

		if row["a.b.c"] != 1 {
			t.Fatalf("a.b.c 期望 1，实际：%v", row["a.b.c"])
		}
		if _, ok := row["a"]; ok {
			t.Fatal("展开后不应保留原始嵌套键 a")
		}
		if _, ok := row["a.b"]; ok {
			t.Fatal("展开后不应保留中间嵌套键 a.b")
		}
	})

	t.Run("空对象返回空", func(t *testing.T) {
		source := map[string]interface{}{}
		row := make(map[string]interface{})
		flattenESSource("", source, row)

		if len(row) != 0 {
			t.Fatalf("空对象展开后应为空，实际长度：%d", len(row))
		}
	})
}

func TestESExtractSQLFromTable(t *testing.T) {
	tests := []struct {
		name string
		sql  string
		want string
	}{
		{"简单表名", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 0`, "app_log_user"},
		{"无引号表名", `SELECT * FROM my_index LIMIT 10`, "my_index"},
		{"带点的表名", `SELECT * FROM "iot_pro_biz_operate_log.index.20240626" LIMIT 101`, "iot_pro_biz_operate_log.index.20240626"},
		{"通配符表名", `SELECT * FROM "logs-*" LIMIT 10`, "logs-*"},
		{"多段引号标识符", `SELECT * FROM "iot_pro_biz_operate_log"."index"."20250515" WHERE (("_score">45)) LIMIT 101 OFFSET 0`, "iot_pro_biz_operate_log.index.20250515"},
		{"两段引号标识符", `SELECT * FROM "my_schema"."my_table" LIMIT 10`, "my_schema.my_table"},
		{"带分号的引号表名", `SELECT * FROM "app_log_user";`, "app_log_user"},
		{"带分号的无引号表名", `SELECT * FROM my_index;`, "my_index"},
		{"非 SELECT 语句", `{"query": {"match_all": {}}}`, ""},
		{"空语句", ``, ""},
		{"FROM 语句片段", `FROM "test"`, "test"},
		{"FROM 后无表名", `SELECT * FROM`, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractESSQLFromTable(tt.sql)
			if got != tt.want {
				t.Fatalf("extractESSQLFromTable(%q) = %q, want %q", tt.sql, got, tt.want)
			}
		})
	}
}

func TestESParseSQL(t *testing.T) {
	tests := []struct {
		name      string
		sql       string
		wantTable string
		wantLimit int
		wantOff   int
		wantOK    bool
	}{
		{"基础SELECT", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 0`, "app_log_user", 101, 0, true},
		{"带点索引名", `SELECT * FROM "iot.index.2024" LIMIT 200`, "iot.index.2024", 200, 0, true},
		{"多段引号", `SELECT * FROM "schema"."table" LIMIT 50 OFFSET 10`, "schema.table", 50, 10, true},
		{"无LIMIT", `SELECT * FROM "my_index"`, "my_index", 0, 0, true},
		{"带分号", `SELECT * FROM "my_index";`, "my_index", 0, 0, true},
		{"LIMIT 后带分号", `SELECT * FROM "my_index" LIMIT 100;`, "my_index", 100, 0, true},
		{"DSL JSON", `{"query": {"match_all": {}}}`, "", 0, 0, false},
		{"分页_第1页", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 0`, "app_log_user", 101, 0, true},
		{"分页_第2页", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 100`, "app_log_user", 101, 100, true},
		{"分页_第3页", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 200`, "app_log_user", 101, 200, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, ok := parseESSQL(tt.sql)
			if ok != tt.wantOK {
				t.Fatalf("parseESSQL(%q) ok=%v want %v", tt.sql, ok, tt.wantOK)
			}
			if !tt.wantOK {
				return
			}
			if parsed.Table != tt.wantTable {
				t.Errorf("Table=%q want %q", parsed.Table, tt.wantTable)
			}
			if parsed.Limit != tt.wantLimit {
				t.Errorf("Limit=%d want %d", parsed.Limit, tt.wantLimit)
			}
			if parsed.Offset != tt.wantOff {
				t.Errorf("Offset=%d want %d", parsed.Offset, tt.wantOff)
			}
		})
	}
}

func TestESParseSQLTrimsTrailingSemicolonFromClauses(t *testing.T) {
	t.Run("WHERE 末尾分号不应进入条件值", func(t *testing.T) {
		parsed, ok := parseESSQL(`select * from log_manage_entity_v2 where operateTime > 1782282529000;`)
		if !ok {
			t.Fatal("parseESSQL 应成功解析带分号的 WHERE 查询")
		}
		if parsed.Where != "operateTime > 1782282529000" {
			t.Fatalf("WHERE 子句不应包含尾部分号，实际=%q", parsed.Where)
		}
	})

	t.Run("ORDER BY 末尾分号不应进入排序子句", func(t *testing.T) {
		parsed, ok := parseESSQL(`select * from log_manage_entity_v2 order by operateTime desc;`)
		if !ok {
			t.Fatal("parseESSQL 应成功解析带分号的 ORDER BY 查询")
		}
		if parsed.OrderBy != "operateTime desc" {
			t.Fatalf("ORDER BY 子句不应包含尾部分号，实际=%q", parsed.OrderBy)
		}
	})
}

func TestESConvertWhere(t *testing.T) {
	tests := []struct {
		name  string
		where string
		key   string
	}{
		{"等值", `"status" = 'active'`, "term"},
		{"范围", `"age" > 18`, "range"},
		{"score", `"_score" > 45`, "range"},
		{"AND", `"a" = '1' AND "b" > 2`, "bool"},
		{"OR", `"a" = '1' OR "b" = '2'`, "bool"},
		{"IS NULL", `"name" IS NULL`, "bool"},
		{"IS NOT NULL", `"name" IS NOT NULL`, "exists"},
		{"LIKE", `"name" LIKE 'test%'`, "wildcard"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := convertSQLWhereToESQuery(tt.where)
			if result == nil {
				t.Fatal("convertSQLWhereToESQuery returned nil")
			}
			if _, ok := result[tt.key]; !ok {
				keys := make([]string, 0, len(result))
				for k := range result {
					keys = append(keys, k)
				}
				t.Errorf("expected key %q, got %v", tt.key, keys)
			}
		})
	}
}
