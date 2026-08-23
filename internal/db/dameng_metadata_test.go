package db

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestEscapeDamengMetadataLiteral_NormalizesAndEscapes(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		" Sales'Ops ": "SALES''OPS",
		"orders":      "ORDERS",
		"MiXeD":       "MIXED",
		"":            "",
	}
	for input, want := range tests {
		if got := escapeDamengMetadataLiteral(input); got != want {
			t.Fatalf("escapeDamengMetadataLiteral(%q) = %q, want %q", input, got, want)
		}
	}
}
func TestCollectDamengDatabaseNames_UsesCurrentSchemaFallback(t *testing.T) {
	t.Parallel()

	got, err := collectDamengDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		switch query {
		case damengDatabaseQueries[0]:
			return []map[string]interface{}{{"DATABASE_NAME": "APP_SCHEMA"}}, nil, nil
		case damengDatabaseQueries[1]:
			return []map[string]interface{}{{"DATABASE_NAME": "app_schema"}}, nil, nil
		default:
			return nil, nil, errors.New("permission denied")
		}
	})
	if err != nil {
		t.Fatalf("collectDamengDatabaseNames 返回错误: %v", err)
	}

	want := []string{"APP_SCHEMA"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected database names, got=%v want=%v", got, want)
	}
}

func TestCollectDamengDatabaseNames_CollectsOwnersWhenVisible(t *testing.T) {
	t.Parallel()

	got, err := collectDamengDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		switch query {
		case damengDatabaseQueries[0], damengDatabaseQueries[1], damengDatabaseQueries[2], damengDatabaseQueries[3], damengDatabaseQueries[4], damengDatabaseQueries[5]:
			return []map[string]interface{}{}, nil, nil
		case damengDatabaseQueries[6]:
			return []map[string]interface{}{{"OWNER": "BIZ"}, {"OWNER": "audit"}}, nil, nil
		case damengDatabaseQueries[7]:
			return []map[string]interface{}{{"OWNER": "BIZ"}}, nil, nil
		default:
			return nil, nil, nil
		}
	})
	if err != nil {
		t.Fatalf("collectDamengDatabaseNames 返回错误: %v", err)
	}

	want := []string{"audit", "BIZ"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected database names, got=%v want=%v", got, want)
	}
}

func TestCollectDamengDatabaseNames_ReturnsErrorWhenNoNameResolved(t *testing.T) {
	t.Parallel()

	expectErr := errors.New("last query failed")
	got, err := collectDamengDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		if query == damengDatabaseQueries[len(damengDatabaseQueries)-1] {
			return nil, nil, expectErr
		}
		return nil, nil, errors.New("permission denied")
	})
	if err == nil {
		t.Fatalf("期望返回错误，实际 got=%v", got)
	}
	if !errors.Is(err, expectErr) {
		t.Fatalf("错误不符合预期: %v", err)
	}
}

// TestCollectDamengDatabaseNames_IncludesSYSDBA 验证 SYSDBA（达梦默认管理员 schema）
// 不会被系统 schema 过滤排除。
func TestCollectDamengDatabaseNames_IncludesSYSDBA(t *testing.T) {
	t.Parallel()

	got, err := collectDamengDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		switch query {
		case damengDatabaseQueries[0]:
			// 查询 0 返回 SYSDBA（之前会被排除，修复后应该返回）
			return []map[string]interface{}{{"DATABASE_NAME": "SYSDBA"}}, nil, nil
		default:
			return nil, nil, errors.New("permission denied")
		}
	})
	if err != nil {
		t.Fatalf("collectDamengDatabaseNames 返回错误: %v", err)
	}

	want := []string{"SYSDBA"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SYSDBA 应该包含在结果中, got=%v want=%v", got, want)
	}
}

// TestCollectDamengDatabaseNames_FallbackToCurrentUser 验证当所有查询都失败时
// 兜底查询 SELECT USER FROM DUAL 能返回当前用户作为 schema。
func TestCollectDamengDatabaseNames_FallbackToCurrentUser(t *testing.T) {
	t.Parallel()

	lastQuery := damengDatabaseQueries[len(damengDatabaseQueries)-1]
	got, err := collectDamengDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		if query == lastQuery {
			return []map[string]interface{}{{"DATABASE_NAME": "SYSDBA"}}, nil, nil
		}
		// 前面所有查询要么返回空要么报错
		return []map[string]interface{}{}, nil, nil
	})
	if err != nil {
		t.Fatalf("collectDamengDatabaseNames 返回错误: %v", err)
	}

	want := []string{"SYSDBA"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("兜底查询应该返回当前用户, got=%v want=%v", got, want)
	}
}

func TestBuildDamengColumnsQuery_IncludesColumnCommentsJoin(t *testing.T) {
	t.Parallel()

	userQuery := buildDamengColumnsQuery("", "orders")
	if !strings.Contains(userQuery, "user_col_comments") {
		t.Fatalf("expected user query to join user_col_comments, got: %s", userQuery)
	}
	if !strings.Contains(userQuery, "cc.comments AS col_comment") {
		t.Fatalf("expected user query to select column comments as col_comment, got: %s", userQuery)
	}
	if strings.Contains(strings.ToLower(userQuery), " as comment") {
		t.Fatalf("dameng forbids AS comment alias (reserved word), got: %s", userQuery)
	}

	allQuery := buildDamengColumnsQuery("app", "orders")
	if !strings.Contains(allQuery, "all_col_comments") {
		t.Fatalf("expected schema query to join all_col_comments, got: %s", allQuery)
	}
	if !strings.Contains(allQuery, "cc.comments AS col_comment") {
		t.Fatalf("expected schema query to select column comments as col_comment, got: %s", allQuery)
	}
	if strings.Contains(strings.ToLower(allQuery), " as comment") {
		t.Fatalf("dameng forbids AS comment alias (reserved word), got: %s", allQuery)
	}
}

func TestDamengMetadataQueriesEscapeSchemaAndTableLiterals(t *testing.T) {
	t.Parallel()

	const schema = "Sales'Ops"
	const table = "Order'Items"
	wantSchema := "SALES''OPS"
	wantTable := "ORDER''ITEMS"

	queries := []string{
		buildDamengColumnsQuery(schema, table),
		buildDamengColumnCommentsQuery(schema, table),
		buildDamengTableCommentQuery(schema, table),
		buildDamengAutoIncrementColumnsQuery(schema, table),
		buildDamengIndexesQuery(schema, table),
		buildDamengForeignKeysQuery(schema, table),
	}
	for i, query := range queries {
		if !strings.Contains(query, wantSchema) || !strings.Contains(query, wantTable) {
			t.Fatalf("metadata query %d should escape normalized schema/table literals, got: %s", i, query)
		}
		if strings.Contains(query, "'SALES'OPS'") || strings.Contains(query, "'ORDER'ITEMS'") {
			t.Fatalf("metadata query %d contains an unescaped apostrophe, got: %s", i, query)
		}
	}
}

func TestBuildDamengColumnCommentsQueryUsesNativeDictionary(t *testing.T) {
	t.Parallel()

	userQuery := buildDamengColumnCommentsQuery("", "orders")
	for _, want := range []string{
		"FROM SYS.SYSCOLUMNCOMMENTS",
		"SCHNAME = USER",
		"TVNAME = 'ORDERS'",
		"COLNAME AS column_name",
		"COMMENT$ AS col_comment",
	} {
		if !strings.Contains(userQuery, want) {
			t.Fatalf("current-schema native comment query should contain %q, got: %s", want, userQuery)
		}
	}

	ownerQuery := buildDamengColumnCommentsQuery("biz", "orders")
	if !strings.Contains(ownerQuery, "SCHNAME = 'BIZ'") || !strings.Contains(ownerQuery, "TVNAME = 'ORDERS'") {
		t.Fatalf("schema native comment query should target the selected table, got: %s", ownerQuery)
	}
}

func TestBuildDamengTableCommentQueryUsesSchemaAppropriateDictionaryView(t *testing.T) {
	t.Parallel()

	userQuery := buildDamengTableCommentQuery("", "orders")
	if !strings.Contains(userQuery, "FROM user_tab_comments") || !strings.Contains(userQuery, "table_name = 'ORDERS'") {
		t.Fatalf("expected current-schema table comment query, got: %s", userQuery)
	}

	allQuery := buildDamengTableCommentQuery("biz", "orders")
	if !strings.Contains(allQuery, "FROM all_tab_comments") || !strings.Contains(allQuery, "owner = 'BIZ'") || !strings.Contains(allQuery, "table_name = 'ORDERS'") {
		t.Fatalf("expected schema table comment query, got: %s", allQuery)
	}
}

func TestAppendDamengTableCommentDDLAvoidsDuplicateAndEscapesLiteral(t *testing.T) {
	t.Parallel()

	ddl := appendDamengTableCommentDDL(`CREATE TABLE "BIZ"."ORDERS" ("ID" NUMBER)`, "biz", "orders", "订单'归档")
	if !strings.Contains(ddl, `COMMENT ON TABLE "BIZ"."ORDERS" IS '订单''归档';`) {
		t.Fatalf("expected escaped table comment DDL, got: %s", ddl)
	}
	if !strings.Contains(ddl, "(\"ID\" NUMBER);\n\nCOMMENT ON TABLE") {
		t.Fatalf("expected create statement terminator before table comment, got: %s", ddl)
	}

	duplicated := appendDamengTableCommentDDL(ddl, "biz", "orders", "新备注")
	if duplicated != ddl {
		t.Fatalf("expected existing table comment DDL to remain unchanged, got: %s", duplicated)
	}
}

func TestBuildDamengColumnDefinitions_MapsComment(t *testing.T) {
	t.Parallel()

	columns := buildDamengColumnDefinitions([]map[string]interface{}{
		{
			"COLUMN_NAME": "ID",
			"DATA_TYPE":   "NUMBER",
			"NULLABLE":    "N",
			"COLUMN_KEY":  "PRI",
			"COL_COMMENT": "主键",
		},
	})

	if len(columns) != 1 {
		t.Fatalf("expected one column, got=%d", len(columns))
	}
	if columns[0].Comment != "主键" {
		t.Fatalf("expected comment to be mapped, got=%q", columns[0].Comment)
	}
}

func TestBuildDamengIndexesQuery_JoinsAllViewsByIndexOwner(t *testing.T) {
	t.Parallel()

	query := buildDamengIndexesQuery("app", "orders")

	if !strings.Contains(query, "JOIN all_indexes i ON i.owner = c.index_owner AND i.index_name = c.index_name") {
		t.Fatalf("expected schema query to join ALL_INDEXES through INDEX_OWNER, got: %s", query)
	}
	if !strings.Contains(query, "i.index_type") {
		t.Fatalf("expected index type metadata to be selected, got: %s", query)
	}
	if strings.Contains(strings.ToLower(query), "using (index_name, owner)") {
		t.Fatalf("ALL_IND_COLUMNS exposes INDEX_OWNER rather than OWNER, got: %s", query)
	}
	if !strings.Contains(query, "c.table_owner = 'APP'") || !strings.Contains(query, "c.table_name = 'ORDERS'") {
		t.Fatalf("expected normalized schema and table predicates, got: %s", query)
	}
	if !strings.Contains(query, "ORDER BY c.index_name, c.column_position") {
		t.Fatalf("expected stable multi-column index ordering, got: %s", query)
	}
}

func TestBuildDamengIndexesQuery_UsesUserViewsWithoutSchema(t *testing.T) {
	t.Parallel()

	query := buildDamengIndexesQuery("", "orders")

	if !strings.Contains(query, "FROM user_ind_columns c") {
		t.Fatalf("expected current-schema index columns view, got: %s", query)
	}
	if !strings.Contains(query, "JOIN user_indexes i ON i.index_name = c.index_name") {
		t.Fatalf("expected current-schema index metadata join, got: %s", query)
	}
}

func TestBuildDamengIndexDefinitions_MapsCaseInsensitiveMultiColumnMetadata(t *testing.T) {
	t.Parallel()

	indexes := buildDamengIndexDefinitions([]map[string]interface{}{
		{
			"index_name":      "IDX_ORDERS_TENANT_CREATED",
			"column_name":     "TENANT_ID",
			"uniqueness":      "NONUNIQUE",
			"column_position": 1,
			"index_type":      "NORMAL",
		},
		{
			"INDEX_NAME":      "IDX_ORDERS_TENANT_CREATED",
			"COLUMN_NAME":     "CREATED_AT",
			"UNIQUENESS":      "NONUNIQUE",
			"COLUMN_POSITION": "2",
		},
		{
			"INDEX_NAME":      "UK_ORDERS_NUMBER",
			"COLUMN_NAME":     "ORDER_NUMBER",
			"UNIQUENESS":      "UNIQUE",
			"COLUMN_POSITION": 1,
		},
	})

	if len(indexes) != 3 {
		t.Fatalf("expected three index columns, got=%d", len(indexes))
	}
	if indexes[0].Name != "IDX_ORDERS_TENANT_CREATED" || indexes[0].ColumnName != "TENANT_ID" || indexes[0].NonUnique != 1 || indexes[0].SeqInIndex != 1 {
		t.Fatalf("unexpected first index column: %#v", indexes[0])
	}
	if indexes[0].IndexType != "NORMAL" {
		t.Fatalf("expected index type metadata to be preserved, got: %#v", indexes[0])
	}
	if indexes[1].SeqInIndex != 2 {
		t.Fatalf("expected second column position, got: %#v", indexes[1])
	}
	if indexes[2].NonUnique != 0 {
		t.Fatalf("expected UNIQUE metadata to map to NonUnique=0, got: %#v", indexes[2])
	}
}
