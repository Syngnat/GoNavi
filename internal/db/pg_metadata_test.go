package db

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestBuildPGLikeMetadataQueriesUseVisibleRelationForPureTable(t *testing.T) {
	t.Parallel()

	columnQuery := buildPGLikeColumnsMetadataQuery("", "users")
	if !strings.Contains(columnQuery, "pg_catalog.pg_table_is_visible(c.oid)") {
		t.Fatalf("expected visible relation predicate for column metadata, got %s", columnQuery)
	}
	if strings.Contains(columnQuery, "n.nspname = 'public'") || strings.Contains(columnQuery, "current_schema()") {
		t.Fatalf("pure table column metadata should not force public/current_schema, got %s", columnQuery)
	}

	indexQuery := buildPGLikeIndexesMetadataQuery("", "users")
	if !strings.Contains(indexQuery, "pg_catalog.pg_table_is_visible(t.oid)") {
		t.Fatalf("expected visible relation predicate for index metadata, got %s", indexQuery)
	}
	if strings.Contains(indexQuery, "n.nspname = 'public'") || strings.Contains(indexQuery, "current_schema()") {
		t.Fatalf("pure table index metadata should not force public/current_schema, got %s", indexQuery)
	}
	if !strings.Contains(indexQuery, "ix.indnkeyatts") || strings.Contains(indexQuery, "WITH ORDINALITY") {
		t.Fatalf("modern index metadata should use indnkeyatts without WITH ORDINALITY, got %s", indexQuery)
	}
	legacyIndexQuery := buildPGLikeIndexesMetadataLegacyQuery("", "users")
	if !strings.Contains(legacyIndexQuery, "pg_catalog.pg_table_is_visible(t.oid)") {
		t.Fatalf("expected visible relation predicate for legacy index metadata, got %s", legacyIndexQuery)
	}
	if strings.Contains(legacyIndexQuery, "WITH ORDINALITY") || strings.Contains(legacyIndexQuery, "indnkeyatts") {
		t.Fatalf("legacy index metadata must remain PostgreSQL 9.x compatible, got %s", legacyIndexQuery)
	}

	foreignKeyQuery := buildPGLikeForeignKeysMetadataQuery("", "users")
	if !strings.Contains(foreignKeyQuery, "pg_catalog.pg_table_is_visible(c.oid)") {
		t.Fatalf("expected visible relation predicate for foreign-key metadata, got %s", foreignKeyQuery)
	}
	if strings.Contains(foreignKeyQuery, "n.nspname = 'public'") || strings.Contains(foreignKeyQuery, "current_schema()") {
		t.Fatalf("pure table foreign-key metadata should not force public/current_schema, got %s", foreignKeyQuery)
	}
	if !strings.Contains(foreignKeyQuery, "ccu.constraint_catalog = tc.constraint_catalog") || !strings.Contains(foreignKeyQuery, "ccu.constraint_schema = tc.constraint_schema") || strings.Contains(foreignKeyQuery, "ccu.table_schema = tc.table_schema") {
		t.Fatalf("foreign-key metadata should join constraint usage by constraint schema to preserve cross-schema references, got %s", foreignKeyQuery)
	}

	triggerQuery := buildPGLikeTriggersMetadataQuery("", "users")
	if !strings.Contains(triggerQuery, "t.action_orientation") {
		t.Fatalf("trigger metadata should expose firing orientation for safe restoration, got %s", triggerQuery)
	}
	if !strings.Contains(triggerQuery, "pg_catalog.pg_table_is_visible(c.oid)") {
		t.Fatalf("expected visible relation predicate for trigger metadata, got %s", triggerQuery)
	}
	if strings.Contains(triggerQuery, "n.nspname = 'public'") || strings.Contains(triggerQuery, "current_schema()") {
		t.Fatalf("pure table trigger metadata should not force public/current_schema, got %s", triggerQuery)
	}
}

func TestGetPGLikeTriggerOrientationHandlesDriverKeyShapes(t *testing.T) {
	t.Parallel()

	if got := getPGLikeTriggerOrientation(map[string]interface{}{"ACTION_ORIENTATION": "ROW"}); got != "ROW" {
		t.Fatalf("uppercase orientation = %q, want ROW", got)
	}
	if got := getPGLikeTriggerOrientation(map[string]interface{}{"action_orientation": nil}); got != "" {
		t.Fatalf("nil orientation = %q, want empty", got)
	}
	if got := getPGLikeTriggerOrientation(map[string]interface{}{"action_orientation": []byte("STATEMENT")}); got != "STATEMENT" {
		t.Fatalf("byte orientation = %q, want STATEMENT", got)
	}
}

type triggerMetadataQueryStub struct {
	calls int
}

func (s *triggerMetadataQueryStub) Query(query string) ([]map[string]interface{}, []string, error) {
	s.calls++
	if s.calls == 1 {
		return nil, nil, fmt.Errorf("column action_orientation does not exist")
	}
	if s.calls == 3 {
		return []map[string]interface{}{{"trigger_name": "users_bi", "action_orientation": "ROW"}}, nil, nil
	}
	return []map[string]interface{}{{"trigger_name": "users_bi"}}, nil, nil
}

func TestQueryPGLikeTriggersMetadataFallsBackWithoutOrientation(t *testing.T) {
	t.Parallel()

	stub := &triggerMetadataQueryStub{}
	data, err := queryPGLikeTriggersMetadata(stub, "public", "users")
	if err != nil {
		t.Fatalf("queryPGLikeTriggersMetadata returned error: %v", err)
	}
	if len(data) != 1 || stub.calls != 3 {
		t.Fatalf("fallback calls/data = %d/%#v, want 3/one row", stub.calls, data)
	}
	if got := getPGLikeTriggerOrientation(data[0]); got != "ROW" {
		t.Fatalf("fallback orientation = %q, want ROW", got)
	}
}

type localizedTriggerMetadataQueryStub struct {
	calls int
}

func (s *localizedTriggerMetadataQueryStub) Query(query string) ([]map[string]interface{}, []string, error) {
	s.calls++
	switch s.calls {
	case 1:
		return nil, nil, fmt.Errorf("查询失败：列不可用")
	case 2:
		return []map[string]interface{}{{"trigger_name": "Users"}, {"trigger_name": "users"}}, nil, nil
	default:
		return []map[string]interface{}{
			{"trigger_name": "Users", "action_orientation": "ROW"},
			{"trigger_name": "users", "action_orientation": "STATEMENT"},
		}, nil, nil
	}
}

func TestQueryPGLikeTriggersMetadataFallsBackForLocalizedErrorsAndKeepsCaseDistinctNames(t *testing.T) {
	t.Parallel()

	stub := &localizedTriggerMetadataQueryStub{}
	data, err := queryPGLikeTriggersMetadata(stub, "public", "users")
	if err != nil {
		t.Fatalf("queryPGLikeTriggersMetadata returned error: %v", err)
	}
	if stub.calls != 3 || len(data) != 2 {
		t.Fatalf("fallback calls/data = %d/%#v, want 3/two rows", stub.calls, data)
	}
	if got := getPGLikeTriggerOrientation(data[0]); got != "ROW" {
		t.Fatalf("uppercase trigger orientation = %q, want ROW", got)
	}
	if got := getPGLikeTriggerOrientation(data[1]); got != "STATEMENT" {
		t.Fatalf("lowercase trigger orientation = %q, want STATEMENT", got)
	}
}

func TestBuildPGLikeTriggerOrientationMetadataQueryUsesCatalogBits(t *testing.T) {
	t.Parallel()

	query := buildPGLikeTriggerOrientationMetadataQuery("audit", "users")
	for _, want := range []string{
		"pg_catalog.pg_trigger",
		"(pt.tgtype & 1)",
		"pt.tgisinternal",
		"n.nspname = 'audit'",
		"c.relname = 'users'",
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("orientation query missing %q: %s", want, query)
		}
	}
}

func TestBuildPGLikeMetadataQueriesKeepExplicitSchema(t *testing.T) {
	t.Parallel()

	columnQuery := buildPGLikeColumnsMetadataQuery("audit", "users")
	if !strings.Contains(columnQuery, "n.nspname = 'audit'") {
		t.Fatalf("expected explicit schema predicate, got %s", columnQuery)
	}
	if strings.Contains(columnQuery, "pg_catalog.pg_table_is_visible") {
		t.Fatalf("explicit schema metadata should not use visibility predicate, got %s", columnQuery)
	}

	foreignKeyQuery := buildPGLikeForeignKeysMetadataQuery("audit", "users")
	if !strings.Contains(foreignKeyQuery, "n.nspname = 'audit'") {
		t.Fatalf("expected explicit schema predicate for foreign-key metadata, got %s", foreignKeyQuery)
	}
	if strings.Contains(foreignKeyQuery, "pg_catalog.pg_table_is_visible") {
		t.Fatalf("explicit schema foreign-key metadata should not use visibility predicate, got %s", foreignKeyQuery)
	}

	triggerQuery := buildPGLikeTriggersMetadataQuery("audit", "users")
	if !strings.Contains(triggerQuery, "n.nspname = 'audit'") {
		t.Fatalf("expected explicit schema predicate for trigger metadata, got %s", triggerQuery)
	}
	if strings.Contains(triggerQuery, "pg_catalog.pg_table_is_visible") {
		t.Fatalf("explicit schema trigger metadata should not use visibility predicate, got %s", triggerQuery)
	}
}

func TestNormalizePGLikeMetadataTablePreservesQuotedDottedSegments(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		schemaName string
		tableName  string
		wantSchema string
		wantTable  string
	}{
		{
			name:       "quoted table passed with explicit schema",
			schemaName: "audit.schema",
			tableName:  `"order.items"`,
			wantSchema: "audit.schema",
			wantTable:  "order.items",
		},
		{
			name:       "fully qualified quoted path",
			tableName:  `"audit.schema"."order.items"`,
			wantSchema: "audit.schema",
			wantTable:  "order.items",
		},
		{
			name:       "ordinary qualified path",
			tableName:  "audit.users",
			wantSchema: "audit",
			wantTable:  "users",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			gotSchema, gotTable := normalizePGLikeMetadataTable(test.schemaName, test.tableName)
			if gotSchema != test.wantSchema || gotTable != test.wantTable {
				t.Fatalf("normalizePGLikeMetadataTable(%q,%q)=(%q,%q), want=(%q,%q)", test.schemaName, test.tableName, gotSchema, gotTable, test.wantSchema, test.wantTable)
			}
		})
	}
}

func TestNormalizePGLikeMetadataPartsPreservesLogicalDottedNames(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		schemaName string
		tableName  string
		wantSchema string
		wantTable  string
	}{
		{
			name:       "logical dotted parts",
			schemaName: "Sales.Schema",
			tableName:  "Order.Items",
			wantSchema: "Sales.Schema",
			wantTable:  "Order.Items",
		},
		{
			name:       "delimited dotted parts",
			schemaName: `"Sales.Schema"`,
			tableName:  `"Order.Items"`,
			wantSchema: "Sales.Schema",
			wantTable:  "Order.Items",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			gotSchema, gotTable := normalizePGLikeMetadataParts(test.schemaName, test.tableName)
			if gotSchema != test.wantSchema || gotTable != test.wantTable {
				t.Fatalf("normalizePGLikeMetadataParts(%q,%q)=(%q,%q), want=(%q,%q)", test.schemaName, test.tableName, gotSchema, gotTable, test.wantSchema, test.wantTable)
			}
		})
	}
}

func TestBuildPGLikeTableCommentMetadataQueryEscapesNames(t *testing.T) {
	t.Parallel()

	query := buildPGLikeTableCommentMetadataQuery("audit'schema", "order'items")
	for _, want := range []string{
		"pg_catalog.obj_description(c.oid, 'pg_class') AS table_comment",
		"n.nspname = 'audit''schema'",
		"c.relname = 'order''items'",
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("expected table-comment metadata query to contain %q, got %s", want, query)
		}
	}
	if strings.Contains(query, "pg_catalog.pg_table_is_visible") {
		t.Fatalf("explicit schema table-comment metadata should not use visibility predicate, got %s", query)
	}
}

func TestBuildPGLikeTableCommentMetadataQueryUsesVisibleRelationWithoutSchema(t *testing.T) {
	t.Parallel()

	query := buildPGLikeTableCommentMetadataQuery("", "orders")
	if !strings.Contains(query, "pg_catalog.pg_table_is_visible(c.oid)") {
		t.Fatalf("expected visible relation predicate for table-comment metadata, got %s", query)
	}
}

func TestParsePGLikeTableCommentHandlesMissingAndSpecialValues(t *testing.T) {
	t.Parallel()

	if got := parsePGLikeTableComment(nil); got != "" {
		t.Fatalf("missing table comment = %q, want empty", got)
	}
	want := "  Owner's archive\\path\n第二行  "
	got := parsePGLikeTableComment([]map[string]interface{}{{"TABLE_COMMENT": want}})
	if got != want {
		t.Fatalf("special table comment = %q, want %q", got, want)
	}
}

func TestBuildPGLikeColumnDefinitionsMarksPrimaryKey(t *testing.T) {
	t.Parallel()

	columns := buildPGLikeColumnDefinitions([]map[string]interface{}{
		{
			"column_name":    "id",
			"data_type":      "bigint",
			"is_nullable":    "NO",
			"column_default": "nextval('users_id_seq'::regclass)",
			"column_key":     "PRI",
		},
	})

	if len(columns) != 1 {
		t.Fatalf("unexpected column count: %d", len(columns))
	}
	if columns[0].Name != "id" || columns[0].Key != "PRI" || columns[0].Extra != "auto_increment" {
		t.Fatalf("unexpected primary key column: %+v", columns[0])
	}
}

func TestBuildPGLikeColumnDefinitionsTreatsNilColumnKeyAsEmpty(t *testing.T) {
	t.Parallel()

	columns := buildPGLikeColumnDefinitions([]map[string]interface{}{{
		"column_name": "name",
		"data_type":   "text",
		"is_nullable": "YES",
		"column_key":  nil,
	}})
	if len(columns) != 1 || columns[0].Key != "" {
		t.Fatalf("nil column key should become empty, got %+v", columns)
	}
}

func TestBuildPGLikeColumnDefinitionsRecognizesIdentityAndQualifiedNextval(t *testing.T) {
	t.Parallel()

	query := buildPGLikeColumnsMetadataQuery("public", "users")
	if strings.Contains(query, "to_jsonb") {
		t.Fatalf("column metadata must not depend on to_jsonb: %s", query)
	}
	if !strings.Contains(query, "COALESCE(a.attidentity::text, '') AS identity_generation") {
		t.Fatalf("expected direct identity metadata query, got %s", query)
	}
	fallbackQuery := buildPGLikeColumnsMetadataQueryWithoutIdentity("public", "users")
	if strings.Contains(fallbackQuery, "attidentity") || strings.Contains(fallbackQuery, "to_jsonb") {
		t.Fatalf("legacy fallback must not reference identity columns or to_jsonb: %s", fallbackQuery)
	}
	if !strings.Contains(fallbackQuery, "'' AS identity_generation") {
		t.Fatalf("legacy fallback should return an empty identity value: %s", fallbackQuery)
	}

	columns := buildPGLikeColumnDefinitions([]map[string]interface{}{
		{
			"column_name":         "identity_id",
			"data_type":           "bigint",
			"is_nullable":         "NO",
			"identity_generation": "a",
		},
		{
			"column_name":    "serial_id",
			"data_type":      "bigint",
			"is_nullable":    "NO",
			"column_default": "pg_catalog.nextval('users_id_seq'::regclass)",
		},
	})

	if len(columns) != 2 {
		t.Fatalf("unexpected column count: %d", len(columns))
	}
	for _, column := range columns {
		if column.Extra != "auto_increment" {
			t.Fatalf("expected generated column %q to be auto_increment: %+v", column.Name, column)
		}
	}
}

type metadataQueryResponse struct {
	rows []map[string]interface{}
	err  error
}

type metadataQueryStub struct {
	queries   []string
	responses []metadataQueryResponse
}

func (s *metadataQueryStub) Query(query string) ([]map[string]interface{}, []string, error) {
	s.queries = append(s.queries, query)
	index := len(s.queries) - 1
	if index >= len(s.responses) {
		if len(s.responses) == 0 {
			return nil, nil, fmt.Errorf("unexpected query %d", index+1)
		}
		index = len(s.responses) - 1
	}
	response := s.responses[index]
	return response.rows, nil, response.err
}

func TestQueryPGLikeColumnsMetadataFallsBackForLegacyPostgres(t *testing.T) {
	t.Parallel()

	stub := &metadataQueryStub{responses: []metadataQueryResponse{
		{err: errors.New(`pq: column "attidentity" does not exist`)},
		{rows: []map[string]interface{}{{
			"column_name":    "id",
			"data_type":      "integer",
			"is_nullable":    "NO",
			"column_default": nil,
			"column_key":     "PRI",
		}}},
	}}
	state := &pgMetadataQueryState{}
	data, err := queryPGLikeColumnsMetadata(stub, state, "ts_overview", "basic_area_code")
	if err != nil {
		t.Fatalf("queryPGLikeColumnsMetadata returned error: %v", err)
	}
	if _, err := queryPGLikeColumnsMetadata(stub, state, "ts_overview", "basic_area_code"); err != nil {
		t.Fatalf("cached queryPGLikeColumnsMetadata returned error: %v", err)
	}
	if len(stub.queries) != 3 {
		t.Fatalf("query count = %d, want 3", len(stub.queries))
	}
	if state.columnsMode() != pgMetadataQueryLegacy {
		t.Fatalf("column mode = %v, want legacy", state.columnsMode())
	}
	if !strings.Contains(stub.queries[0], "attidentity") {
		t.Fatalf("first query should probe attidentity: %s", stub.queries[0])
	}
	for _, query := range stub.queries[1:] {
		if !strings.Contains(query, "'' AS identity_generation") {
			t.Fatalf("cached fallback query should not require identity metadata: %s", query)
		}
	}
	columns := buildPGLikeColumnDefinitions(data)
	if len(columns) != 1 || columns[0].Name != "id" || columns[0].Key != "PRI" {
		t.Fatalf("unexpected fallback columns: %+v", columns)
	}
}

func TestQueryPGLikeColumnsMetadataDoesNotFallbackForConnectionErrors(t *testing.T) {
	t.Parallel()

	connectionErr := errors.New(`connection reset by peer while executing SELECT a.attidentity`)
	stub := &metadataQueryStub{responses: []metadataQueryResponse{{err: connectionErr}}}
	_, err := queryPGLikeColumnsMetadata(stub, &pgMetadataQueryState{}, "public", "users")
	if !errors.Is(err, connectionErr) {
		t.Fatalf("expected connection error, got %v", err)
	}
	if len(stub.queries) != 1 {
		t.Fatalf("connection errors must not trigger compatibility fallback, queries=%d", len(stub.queries))
	}
}

func TestQueryPGLikeColumnsMetadataPreservesFallbackError(t *testing.T) {
	t.Parallel()

	capabilityErr := errors.New(`column "attidentity" does not exist`)
	fallbackErr := errors.New("server has gone away")
	stub := &metadataQueryStub{responses: []metadataQueryResponse{
		{err: capabilityErr},
		{err: fallbackErr},
	}}
	_, err := queryPGLikeColumnsMetadata(stub, &pgMetadataQueryState{}, "public", "users")
	if !errors.Is(err, capabilityErr) || !errors.Is(err, fallbackErr) {
		t.Fatalf("expected both query errors, got %v", err)
	}
}

func TestQueryPGLikeIndexesMetadataFallsBackForLegacyPostgres(t *testing.T) {
	t.Parallel()

	stub := &metadataQueryStub{responses: []metadataQueryResponse{
		{err: errors.New(`pq: column "indnkeyatts" does not exist`)},
		{rows: []map[string]interface{}{{
			"index_name":   "idx_users_email",
			"column_name":  "email",
			"is_unique":    "t",
			"seq_in_index": "1",
			"index_type":   "btree",
		}}},
	}}
	state := &pgMetadataQueryState{}
	data, err := queryPGLikeIndexesMetadata(stub, state, "ts_overview", "basic_area_code")
	if err != nil {
		t.Fatalf("queryPGLikeIndexesMetadata returned error: %v", err)
	}
	if _, err := queryPGLikeIndexesMetadata(stub, state, "ts_overview", "basic_area_code"); err != nil {
		t.Fatalf("cached queryPGLikeIndexesMetadata returned error: %v", err)
	}
	if len(stub.queries) != 3 {
		t.Fatalf("query count = %d, want 3", len(stub.queries))
	}
	if state.indexesMode() != pgMetadataQueryLegacy {
		t.Fatalf("index mode = %v, want legacy", state.indexesMode())
	}
	if !strings.Contains(stub.queries[0], "ix.indnkeyatts") {
		t.Fatalf("first query should probe indnkeyatts: %s", stub.queries[0])
	}
	for _, query := range stub.queries[1:] {
		if !strings.Contains(query, "generate_series(0, ix.indnatts - 1)") {
			t.Fatalf("cached legacy query should expand indnatts: %s", query)
		}
	}
	indexes := buildPGLikeIndexDefinitions(data)
	if len(indexes) != 1 || indexes[0].Name != "idx_users_email" || indexes[0].NonUnique != 0 {
		t.Fatalf("unexpected fallback indexes: %+v", indexes)
	}
}

func TestQueryPGLikeIndexesMetadataDoesNotFallbackForConnectionErrors(t *testing.T) {
	t.Parallel()

	connectionErr := errors.New("broken pipe")
	stub := &metadataQueryStub{responses: []metadataQueryResponse{{err: connectionErr}}}
	_, err := queryPGLikeIndexesMetadata(stub, &pgMetadataQueryState{}, "public", "users")
	if !errors.Is(err, connectionErr) {
		t.Fatalf("expected connection error, got %v", err)
	}
	if len(stub.queries) != 1 {
		t.Fatalf("connection errors must not trigger compatibility fallback, queries=%d", len(stub.queries))
	}
}

func TestQueryPGLikeIndexesMetadataPreservesFallbackError(t *testing.T) {
	t.Parallel()

	capabilityErr := errors.New(`column "indnkeyatts" does not exist`)
	fallbackErr := errors.New("server has gone away")
	stub := &metadataQueryStub{responses: []metadataQueryResponse{
		{err: capabilityErr},
		{err: fallbackErr},
	}}
	_, err := queryPGLikeIndexesMetadata(stub, &pgMetadataQueryState{}, "public", "users")
	if !errors.Is(err, capabilityErr) || !errors.Is(err, fallbackErr) {
		t.Fatalf("expected both query errors, got %v", err)
	}
}

func TestQueryPGLikeMetadataCachesModernMode(t *testing.T) {
	t.Parallel()

	rows := []map[string]interface{}{{"column_name": "id"}}
	stub := &metadataQueryStub{responses: []metadataQueryResponse{{rows: rows}}}
	state := &pgMetadataQueryState{}
	if _, err := queryPGLikeColumnsMetadata(stub, state, "public", "users"); err != nil {
		t.Fatalf("first column query: %v", err)
	}
	if _, err := queryPGLikeColumnsMetadata(stub, state, "public", "users"); err != nil {
		t.Fatalf("cached column query: %v", err)
	}
	if state.columnsMode() != pgMetadataQueryModern || len(stub.queries) != 2 {
		t.Fatalf("column mode/calls = %v/%d, want modern/2", state.columnsMode(), len(stub.queries))
	}

	indexRows := []map[string]interface{}{{"index_name": "idx_users"}}
	stub = &metadataQueryStub{responses: []metadataQueryResponse{{rows: indexRows}}}
	state = &pgMetadataQueryState{}
	if _, err := queryPGLikeIndexesMetadata(stub, state, "public", "users"); err != nil {
		t.Fatalf("first index query: %v", err)
	}
	if _, err := queryPGLikeIndexesMetadata(stub, state, "public", "users"); err != nil {
		t.Fatalf("cached index query: %v", err)
	}
	if state.indexesMode() != pgMetadataQueryModern || len(stub.queries) != 2 {
		t.Fatalf("index mode/calls = %v/%d, want modern/2", state.indexesMode(), len(stub.queries))
	}
}

func TestPostgresCloseResetsMetadataQueryState(t *testing.T) {
	t.Parallel()

	client := &PostgresDB{metadataQueryState: &pgMetadataQueryState{}}
	if err := client.Close(); err != nil {
		t.Fatalf("Close() error: %v", err)
	}
	if client.metadataQueryState != nil {
		t.Fatal("Close() should clear cached metadata query capability state")
	}
}

func TestBuildPGLikeIndexDefinitionsParsesStringUnique(t *testing.T) {
	t.Parallel()

	indexes := buildPGLikeIndexDefinitions([]map[string]interface{}{
		{
			"index_name":   "users_email_key",
			"column_name":  "email",
			"is_unique":    "t",
			"seq_in_index": "1",
			"index_type":   "btree",
		},
	})

	if len(indexes) != 1 {
		t.Fatalf("unexpected index count: %d", len(indexes))
	}
	if indexes[0].Name != "users_email_key" || indexes[0].ColumnName != "email" || indexes[0].NonUnique != 0 || indexes[0].SeqInIndex != 1 {
		t.Fatalf("unexpected unique index metadata: %+v", indexes[0])
	}
}

// KingbaseES 会把 `to_jsonb(a)->>'attidentity'` 里的 'attidentity' 当作
// jsonpath 解析并报 syntax error，整条列定义查询失败 —— 结果集表头因此
// 既没有注释也没有类型。Kingbase 必须走不带该写法的专用查询。
func TestKingbaseColumnsMetadataQueryAvoidsJSONPath(t *testing.T) {
	query := buildKingbaseColumnsMetadataQuery("", "bcs_barcode")

	if strings.Contains(query, "to_jsonb") || strings.Contains(query, "->>") {
		t.Fatalf("Kingbase 列定义查询不能包含 jsonb 取值写法，否则会触发 jsonpath 语法错误：%s", query)
	}
	// 这两列是结果集表头展示注释与类型的来源，必须仍在查询里。
	if !strings.Contains(query, "col_description(a.attrelid, a.attnum) AS comment") {
		t.Fatalf("列定义查询必须保留注释列：%s", query)
	}
	if !strings.Contains(query, "pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type") {
		t.Fatalf("列定义查询必须保留类型列：%s", query)
	}
	if !strings.Contains(query, "'' AS identity_generation") {
		t.Fatalf("identity_generation 应退化为空串常量：%s", query)
	}
	if !strings.Contains(query, "pg_catalog.pg_table_is_visible(c.oid)") {
		t.Fatalf("应沿用可见关系谓词：%s", query)
	}
}
