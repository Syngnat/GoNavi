package aicontext

import (
	"strings"
	"testing"
	"GoNavi-Wails/shared/i18n"
)

var databaseContextShellKeys = []string{
	"ai_service.backend.database_context.title",
	"ai_service.backend.database_context.database_type",
	"ai_service.backend.database_context.database_name",
	"ai_service.backend.database_context.table_schema",
	"ai_service.backend.database_context.table_heading",
	"ai_service.backend.database_context.row_count",
	"ai_service.backend.database_context.column_name",
	"ai_service.backend.database_context.column_type",
	"ai_service.backend.database_context.column_nullable",
	"ai_service.backend.database_context.column_primary_key",
	"ai_service.backend.database_context.column_comment",
	"ai_service.backend.database_context.value_yes",
	"ai_service.backend.database_context.value_no",
	"ai_service.backend.database_context.indexes",
	"ai_service.backend.database_context.unique_index",
	"ai_service.backend.database_context.sample_data",
}

const sqlGeneratePromptBodyKey = "ai_service.backend.builtin_prompt.body.sql_generate"
const sqlExplainPromptBodyKey = "ai_service.backend.builtin_prompt.body.sql_explain"
const sqlOptimizePromptBodyKey = "ai_service.backend.builtin_prompt.body.sql_optimize"
const dataAnalyzePromptBodyKey = "ai_service.backend.builtin_prompt.body.data_analyze"
const schemaInsightPromptBodyKey = "ai_service.backend.builtin_prompt.body.schema_insight"
const generalChatPromptBodyKey = "ai_service.backend.builtin_prompt.body.general_chat"

func sampleDatabaseContext() *DatabaseContext {
	return &DatabaseContext{
		DatabaseType: "mysql",
		DatabaseName: "shop_db",
		Tables: []TableContext{
			{
				Name:     "orders",
				Comment:  "订单表",
				RowCount: 42,
				Columns: []ColumnInfo{
					{Name: "id", Type: "bigint", PrimaryKey: true},
					{Name: "note", Type: "varchar(255)", Nullable: true, Comment: "用户备注"},
				},
				Indexes: []IndexInfo{
					{Name: "idx_orders_id", Columns: []string{"id"}, Unique: true},
				},
				SampleRows: []map[string]interface{}{
					{"id": 1, "note": "示例备注"},
				},
			},
		},
	}
}

func TestGetBuiltinPromptsWithTitleLookupLocalizesSQLGenerateBody(t *testing.T) {
	prompts := GetBuiltinPromptsWithTitleLookup(func(key string) string {
		switch key {
		case "ai_service.backend.builtin_prompt.title.sql_generate":
			return "SQL generator"
		case sqlGeneratePromptBodyKey:
			return "LOCALIZED SQL GENERATE PROMPT"
		default:
			return key
		}
	})

	if got := prompts["SQL generator"]; got != "LOCALIZED SQL GENERATE PROMPT" {
		t.Fatalf("expected sql_generate prompt body to use %s, got:\n%s", sqlGeneratePromptBodyKey, got)
	}
}

func TestGetBuiltinPromptsWithTitleLookupLocalizesSQLExplainBody(t *testing.T) {
	prompts := GetBuiltinPromptsWithTitleLookup(func(key string) string {
		switch key {
		case "ai_service.backend.builtin_prompt.title.sql_explain":
			return "SQL explainer"
		case sqlExplainPromptBodyKey:
			return "LOCALIZED SQL EXPLAIN PROMPT"
		default:
			return key
		}
	})

	if got := prompts["SQL explainer"]; got != "LOCALIZED SQL EXPLAIN PROMPT" {
		t.Fatalf("expected sql_explain prompt body to use %s, got:\n%s", sqlExplainPromptBodyKey, got)
	}
}

func TestGetBuiltinPromptsWithTitleLookupLocalizesSQLOptimizeBody(t *testing.T) {
	prompts := GetBuiltinPromptsWithTitleLookup(func(key string) string {
		switch key {
		case "ai_service.backend.builtin_prompt.title.sql_optimize":
			return "SQL optimizer"
		case sqlOptimizePromptBodyKey:
			return "LOCALIZED SQL OPTIMIZE PROMPT"
		default:
			return key
		}
	})

	if got := prompts["SQL optimizer"]; got != "LOCALIZED SQL OPTIMIZE PROMPT" {
		t.Fatalf("expected sql_optimize prompt body to use %s, got:\n%s", sqlOptimizePromptBodyKey, got)
	}
}

func TestGetBuiltinPromptsWithTitleLookupLocalizesDataAnalyzeBody(t *testing.T) {
	prompts := GetBuiltinPromptsWithTitleLookup(func(key string) string {
		switch key {
		case "ai_service.backend.builtin_prompt.title.data_analyze":
			return "Data insight analyst"
		case dataAnalyzePromptBodyKey:
			return "LOCALIZED DATA ANALYZE PROMPT"
		default:
			return key
		}
	})

	if got := prompts["Data insight analyst"]; got != "LOCALIZED DATA ANALYZE PROMPT" {
		t.Fatalf("expected data_analyze prompt body to use %s, got:\n%s", dataAnalyzePromptBodyKey, got)
	}
}

func TestGetBuiltinPromptsWithTitleLookupLocalizesSchemaInsightBody(t *testing.T) {
	prompts := GetBuiltinPromptsWithTitleLookup(func(key string) string {
		switch key {
		case "ai_service.backend.builtin_prompt.title.schema_insight":
			return "Schema reviewer"
		case schemaInsightPromptBodyKey:
			return "LOCALIZED SCHEMA INSIGHT PROMPT"
		default:
			return key
		}
	})

	if got := prompts["Schema reviewer"]; got != "LOCALIZED SCHEMA INSIGHT PROMPT" {
		t.Fatalf("expected schema_insight prompt body to use %s, got:\n%s", schemaInsightPromptBodyKey, got)
	}
}

func TestGetBuiltinPromptsWithTitleLookupLocalizesGeneralChatBody(t *testing.T) {
	prompts := GetBuiltinPromptsWithTitleLookup(func(key string) string {
		switch key {
		case "ai_service.backend.builtin_prompt.title.general_chat":
			return "General chat assistant"
		case generalChatPromptBodyKey:
			return "LOCALIZED GENERAL CHAT PROMPT"
		default:
			return key
		}
	})

	if got := prompts["General chat assistant"]; got != "LOCALIZED GENERAL CHAT PROMPT" {
		t.Fatalf("expected general_chat prompt body to use %s, got:\n%s", generalChatPromptBodyKey, got)
	}
}

func TestFormatDatabaseContextDefaultShellUsesEnglishFallback(t *testing.T) {
	formatted := FormatDatabaseContext(sampleDatabaseContext())

	for _, want := range []string{
		"## Current database context",
		"Database type: mysql",
		"Database name: shop_db",
		"### Table structure",
		"#### Table: orders",
		"[about 42 rows]",
		"| Column | Type | Nullable | Primary key | Comment |",
		"| id | bigint | No |",
		"| note | varchar(255) | Yes |",
		"**Indexes:**",
		"(unique)",
		"**Sample data (1 row):**",
	} {
		if !strings.Contains(formatted, want) {
			t.Fatalf("expected formatted context to contain %q, got:\n%s", want, formatted)
		}
	}

	for _, legacy := range []string{"当前数据库上下文", "数据库类型", "数据库名", "表结构", "列名", "可空", "主键", "索引", "唯一", "采样数据", "是", "否"} {
		if strings.Contains(formatted, legacy) {
			t.Fatalf("expected no legacy Chinese shell text %q, got:\n%s", legacy, formatted)
		}
	}

	for _, raw := range []string{"orders", "订单表", "用户备注", "示例备注", "idx_orders_id"} {
		if !strings.Contains(formatted, raw) {
			t.Fatalf("expected raw database content %q to stay unchanged, got:\n%s", raw, formatted)
		}
	}
}

func TestFormatDatabaseContextWithTextLookupLocalizesShell(t *testing.T) {
	lookup := func(key string, params map[string]any) string {
		switch key {
		case "ai_service.backend.database_context.title":
			return "## DB context"
		case "ai_service.backend.database_context.database_type":
			return "Type = " + params["type"].(string)
		case "ai_service.backend.database_context.database_name":
			return "Name = " + params["name"].(string)
		case "ai_service.backend.database_context.table_schema":
			return "### Structure"
		case "ai_service.backend.database_context.table_heading":
			return "#### Object: " + params["table"].(string)
		case "ai_service.backend.database_context.row_count":
			return "[" + params["count"].(string) + " rows approx]"
		case "ai_service.backend.database_context.column_name":
			return "Field"
		case "ai_service.backend.database_context.column_type":
			return "Data type"
		case "ai_service.backend.database_context.column_nullable":
			return "Allows null"
		case "ai_service.backend.database_context.column_primary_key":
			return "PK"
		case "ai_service.backend.database_context.column_comment":
			return "Note"
		case "ai_service.backend.database_context.value_yes":
			return "YES"
		case "ai_service.backend.database_context.value_no":
			return "NO"
		case "ai_service.backend.database_context.indexes":
			return "**Index list:**"
		case "ai_service.backend.database_context.unique_index":
			return " (UNIQUE)"
		case "ai_service.backend.database_context.sample_data":
			return "**Samples (" + params["count"].(string) + "):**"
		default:
			return key
		}
	}

	formatted := FormatDatabaseContextWithTextLookup(sampleDatabaseContext(), lookup)

	for _, want := range []string{"## DB context", "Type = mysql", "Name = shop_db", "### Structure", "#### Object: orders", "[42 rows approx]", "| Field | Data type | Allows null | PK | Note |", "YES", "NO", "**Index list:**", "(UNIQUE)", "**Samples (1):**"} {
		if !strings.Contains(formatted, want) {
			t.Fatalf("expected localized context to contain %q, got:\n%s", want, formatted)
		}
	}
}

func TestFormatDatabaseContextCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range databaseContextShellKeys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing database context shell key %q", language, key)
			}
		}
	}
}

