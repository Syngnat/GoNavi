package app

import "testing"

func TestSanitizeSQLForPgLike_FixesBrokenDoubleDoubleQuotes(t *testing.T) {
	in := `SELECT * FROM ""ldf_server"".""t_user"" LIMIT 1`
	out := sanitizeSQLForPgLike("kingbase", in)
	want := `SELECT * FROM "ldf_server"."t_user" LIMIT 1`
	if out != want {
		t.Fatalf("unexpected sanitize output:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_KingbaseAliasFixesBrokenDoubleDoubleQuotes(t *testing.T) {
	in := `SELECT * FROM ""ldf_server"".""t_user"" LIMIT 1`
	out := sanitizeSQLForPgLike("kingbase8", in)
	want := `SELECT * FROM "ldf_server"."t_user" LIMIT 1`
	if out != want {
		t.Fatalf("unexpected sanitize output:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_FixesBrokenDoubleDoubleQuotes_WithExtraQuotes(t *testing.T) {
	in := `SELECT * FROM ""ldf_server""".""t_user"" LIMIT 1`
	out := sanitizeSQLForPgLike("kingbase", in)
	want := `SELECT * FROM "ldf_server"."t_user" LIMIT 1`
	if out != want {
		t.Fatalf("unexpected sanitize output:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_FixesBrokenDoubleDoubleQuotes_WithQuadQuotes(t *testing.T) {
	in := `SELECT * FROM """"ldf_server"""".""t_user"" LIMIT 1`
	out := sanitizeSQLForPgLike("kingbase", in)
	want := `SELECT * FROM "ldf_server"."t_user" LIMIT 1`
	if out != want {
		t.Fatalf("unexpected sanitize output:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_DoesNotTouchEscapedQuotesInsideIdentifier(t *testing.T) {
	in := `SELECT "a""b" FROM "t""x"`
	out := sanitizeSQLForPgLike("postgres", in)
	if out != in {
		t.Fatalf("should keep valid escaped quotes inside identifier:\nIN:  %s\nOUT: %s", in, out)
	}
}

func TestSanitizeSQLForPgLike_DoesNotTouchDollarQuotedStrings(t *testing.T) {
	in := "SELECT $$\"\"ldf_server\"\"$$, \"\"ldf_server\"\""
	out := sanitizeSQLForPgLike("postgres", in)
	want := "SELECT $$\"\"ldf_server\"\"$$, \"ldf_server\""
	if out != want {
		t.Fatalf("unexpected sanitize output for dollar quoted string:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_DoesNotModifyOtherDBTypes(t *testing.T) {
	in := `SELECT * FROM ""ldf_server""`
	out := sanitizeSQLForPgLike("mysql", in)
	if out != in {
		t.Fatalf("non-PG-like db should not be sanitized:\nIN:  %s\nOUT: %s", in, out)
	}
}

func TestIsReadOnlySQLQuery_DoesNotTreatExecAsReadOnly(t *testing.T) {
	if isReadOnlySQLQuery("sqlserver", "EXEC sp_who2") {
		t.Fatal("EXEC should not be treated as read-only SQL")
	}
}

func TestIsReadOnlySQLQuery_ClassifiesWithByTopLevelOperation(t *testing.T) {
	readQuery := "WITH target AS (SELECT id FROM users WHERE active = 1) SELECT * FROM target"
	if !isReadOnlySQLQuery("postgres", readQuery) {
		t.Fatal("WITH ... SELECT should stay read-only")
	}

	writeQuery := "WITH target AS (SELECT id FROM users WHERE active = 1) UPDATE users SET synced = 1 WHERE id IN (SELECT id FROM target)"
	if isReadOnlySQLQuery("postgres", writeQuery) {
		t.Fatal("WITH ... UPDATE should not be treated as read-only")
	}

	writeCTEQuery := "WITH moved AS (DELETE FROM audit_logs WHERE created_at < NOW() RETURNING id) SELECT * FROM moved"
	if isReadOnlySQLQuery("postgres", writeCTEQuery) {
		t.Fatal("data-changing CTE should not be treated as read-only")
	}
}

func TestIsReadOnlySQLQuery_TreatsSelectIntoAsWrite(t *testing.T) {
	query := "SELECT * INTO archived_users FROM users"
	if isReadOnlySQLQuery("postgres", query) {
		t.Fatal("SELECT INTO should not be treated as read-only")
	}
}

func TestIsReadOnlySQLQueryRejectsExecutableMySQLComments(t *testing.T) {
	unsafeQueries := []struct {
		dbType string
		query  string
	}{
		{dbType: "mysql", query: "SELECT 1 /*!50000 INTO OUTFILE '/tmp/gonavi' */"},
		{dbType: "mysql", query: "/*!50000 DELETE FROM accounts */ SELECT 1"},
		{dbType: "mariadb", query: "SELECT 1 /*M!100100 INTO OUTFILE '/tmp/gonavi' */"},
		{dbType: "oceanbase", query: "SELECT /*!50700 SQL_NO_CACHE */ 1"},
	}
	for _, test := range unsafeQueries {
		if isReadOnlySQLQuery(test.dbType, test.query) {
			t.Fatalf("%s executable comment was classified read-only: %q", test.dbType, test.query)
		}
	}

	for _, query := range []string{
		"SELECT /* ordinary comment */ 1",
		"SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1",
		"SELECT '/*!50000 DELETE FROM accounts */'",
	} {
		if !isReadOnlySQLQuery("mysql", query) {
			t.Fatalf("ordinary MySQL SELECT was classified as write: %q", query)
		}
	}
	if !isReadOnlySQLQuery("postgres", "SELECT 1 /*!50000 ignored by PostgreSQL */") {
		t.Fatal("non-MySQL dialect treated an ordinary block comment as executable")
	}
}

func TestIsReadOnlySQLQuery_TreatsKafkaConsumeAsReadOnly(t *testing.T) {
	if !isReadOnlySQLQuery("kafka", `CONSUME GROUP "analytics" FROM "orders.events" LIMIT 20`) {
		t.Fatal("Kafka CONSUME should be treated as read-only")
	}
}

func TestShouldTryQueryResultFirstRoutesMQTTUnsubscribeThroughQuery(t *testing.T) {
	if !shouldTryQueryResultFirst("mqtt", `UNSUBSCRIBE FROM "devices/+/telemetry"`) {
		t.Fatal("MQTT UNSUBSCRIBE should use the query command path")
	}
	if shouldTryQueryResultFirst("kafka", `UNSUBSCRIBE FROM "devices/+/telemetry"`) {
		t.Fatal("UNSUBSCRIBE query routing must remain scoped to MQTT")
	}
}

func TestIsReadOnlySQLQuery_TreatsMongoFindAsReadOnly(t *testing.T) {
	if !isReadOnlySQLQuery("mongodb", `{"find":"users","filter":{"active":true}}`) {
		t.Fatal("MongoDB find command should be treated as read-only")
	}
}

func TestIsReadOnlySQLQuery_TreatsMongoDeleteAsWrite(t *testing.T) {
	if isReadOnlySQLQuery("mongodb", `{"delete":"users","deletes":[{"q":{"active":false},"limit":0}]}`) {
		t.Fatal("MongoDB delete command should not be treated as read-only")
	}
}

func TestIsReadOnlySQLQuery_TreatsMongoAggregateOutputStagesAsWrites(t *testing.T) {
	for _, query := range []string{
		`{"aggregate":"users","pipeline":[{"$match":{"active":true}},{"$out":"active_users"}],"cursor":{}}`,
		`{"aggregate":"users","pipeline":[{"$merge":{"into":"active_users"}}],"cursor":{}}`,
	} {
		if isReadOnlySQLQuery("mongodb", query) {
			t.Fatalf("Mongo aggregate write stage was classified read-only: %s", query)
		}
	}
	if !isReadOnlySQLQuery("mongodb", `{"aggregate":"users","pipeline":[{"$match":{"active":true}}],"cursor":{}}`) {
		t.Fatal("read-only Mongo aggregate was classified as write")
	}
}

func TestIsReadOnlySQLQuery_TreatsExecutingExplainWritesAsWrites(t *testing.T) {
	for _, query := range []string{
		"EXPLAIN ANALYZE UPDATE users SET active = false",
		"EXPLAIN (ANALYZE true, BUFFERS true) DELETE FROM users",
		"EXPLAIN ANALYSE WITH removed AS (DELETE FROM users RETURNING id) SELECT * FROM removed",
	} {
		if isReadOnlySQLQuery("postgres", query) {
			t.Fatalf("executing EXPLAIN write was classified read-only: %s", query)
		}
	}
	if !isReadOnlySQLQuery("postgres", "EXPLAIN UPDATE users SET active = false") {
		t.Fatal("non-executing EXPLAIN was classified as write")
	}
	if !isReadOnlySQLQuery("postgres", "EXPLAIN ANALYZE SELECT * FROM users") {
		t.Fatal("EXPLAIN ANALYZE SELECT was classified as write")
	}
}

func TestIsReadOnlySQLQuery_TreatsMutablePragmasAsWrites(t *testing.T) {
	for _, query := range []string{
		"PRAGMA user_version = 7",
		"PRAGMA main.application_id(42)",
		`PRAGMA "main".user_version = 123`,
		"PRAGMA [main].user_version = 124",
		"PRAGMA `main`.user_version = 125",
		"PRAGMA optimize",
		"PRAGMA incremental_vacuum",
		"PRAGMA wal_checkpoint",
	} {
		if isReadOnlySQLQuery("sqlite", query) {
			t.Fatalf("mutable PRAGMA was classified read-only: %s", query)
		}
	}
	if !isReadOnlySQLQuery("sqlite", "PRAGMA table_info('users')") {
		t.Fatal("metadata PRAGMA was classified as write")
	}
	if !isReadOnlySQLQuery("sqlite", "PRAGMA database_list") {
		t.Fatal("read-only no-argument PRAGMA was classified as write")
	}
}

func TestIsReadOnlySQLQuery_TreatsMilvusJSONQueriesAsReadOnly(t *testing.T) {
	for _, query := range []string{
		`{"list_collections":true}`,
		`{"query":"products","filter":"id >= 1","limit":10}`,
		`{"search":"products","vector":[0.1,0.2,0.3],"limit":5}`,
		`{"collection":"products","filter":"id >= 1"}`,
	} {
		if !isReadOnlySQLQuery("milvus", query) {
			t.Fatalf("Milvus query should be read-only: %s", query)
		}
	}
	if !isReadOnlySQLQuery("milvus-db", `{"count":"products"}`) {
		t.Fatal("Milvus aliases should preserve JSON read classification")
	}
}

func TestIsReadOnlySQLQuery_TreatsMilvusSelectPreviewsAsReadOnly(t *testing.T) {
	for _, dbType := range []string{"milvus", "milvusdb", "milvus-db"} {
		for _, query := range []string{
			`SELECT * FROM "products" LIMIT 101 OFFSET 0`,
			`SELECT COUNT(*) as total FROM "products"`,
		} {
			if !isReadOnlySQLQuery(dbType, query) {
				t.Fatalf("Milvus SELECT preview should be read-only: dbType=%s query=%s", dbType, query)
			}
		}
	}
}

func TestIsReadOnlySQLQuery_TreatsMilvusJSONWritesAsWrites(t *testing.T) {
	for _, query := range []string{
		`{"create_collection":"products","dimension":3}`,
		`{"insert":"products","data":[{"id":1}]}`,
		`{"delete":"products","filter":"id in [1]"}`,
		`{"drop_index":"products","index_name":"embedding_idx"}`,
	} {
		if isReadOnlySQLQuery("milvus", query) {
			t.Fatalf("Milvus write should not be read-only: %s", query)
		}
	}
}

func TestIsBatchableWriteSQLStatement_OnlyMatchesRealWriteStatements(t *testing.T) {
	if !isBatchableWriteSQLStatement("mysql", "INSERT INTO demo(id) VALUES (1)") {
		t.Fatal("expected INSERT to be treated as batchable write")
	}
	if !isBatchableWriteSQLStatement("postgres", "WITH target AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM target)") {
		t.Fatal("expected WITH ... DELETE to be treated as batchable write")
	}
	if !isBatchableWriteSQLStatement("postgres", "WITH moved AS (DELETE FROM audit_logs WHERE created_at < NOW() RETURNING id) SELECT * FROM moved") {
		t.Fatal("expected data-changing CTE to be treated as batchable write")
	}
	if !isBatchableWriteSQLStatement("postgres", "SELECT * INTO archived_users FROM users") {
		t.Fatal("expected SELECT INTO to be treated as batchable write")
	}
	if isBatchableWriteSQLStatement("sqlserver", "EXEC sp_who2") {
		t.Fatal("EXEC should not be treated as batchable write")
	}
	if isBatchableWriteSQLStatement("sqlserver", "SET STATISTICS IO ON") {
		t.Fatal("SET STATISTICS should not be treated as batchable write")
	}
}

func TestShouldTryQueryResultFirst_TreatsSQLServerSetAsQueryFirst(t *testing.T) {
	if !shouldTryQueryResultFirst("sqlserver", "SET STATISTICS IO ON") {
		t.Fatal("expected SQL Server SET STATISTICS to try query-first for notice capture")
	}
	if shouldTryQueryResultFirst("mysql", "SET sql_mode = ''") {
		t.Fatal("non-SQLServer SET should not force query-first")
	}
}

func TestShouldTryQueryResultFirst_TreatsSQLServerSystemCommandsAsQueryFirst(t *testing.T) {
	if !shouldTryQueryResultFirst("sqlserver", "sp_who2") {
		t.Fatal("expected bare SQL Server system procedure to try query-first")
	}
	if !shouldTryQueryResultFirst("sqlserver", "DBCC INPUTBUFFER(52)") {
		t.Fatal("expected SQL Server DBCC command to try query-first")
	}
	if shouldTryQueryResultFirst("mysql", "sp_who2") {
		t.Fatal("non-SQLServer system procedure name should not force query-first")
	}
}

func TestShouldTryQueryResultFirst_TreatsSQLServerBareProcedureCallsAsQueryFirst(t *testing.T) {
	if !shouldTryQueryResultFirst("sqlserver", `p_get_select c_dyscript,'projectid = 1',1`) {
		t.Fatal("expected bare SQL Server procedure call to try query-first")
	}
	if !shouldTryQueryResultFirst("sqlserver", `dbo.p_get_select c_dyscript,'projectid = 1',1`) {
		t.Fatal("expected schema-qualified SQL Server procedure call to try query-first")
	}
	if !shouldTryQueryResultFirst("sqlserver", `[dbo].[p_get_select] c_dyscript,'projectid = 1',1`) {
		t.Fatal("expected bracket-qualified SQL Server procedure call to try query-first")
	}
}

func TestShouldTryQueryResultFirst_TreatsReturningAndOutputWritesAsQueryFirst(t *testing.T) {
	if !shouldTryQueryResultFirst("postgres", "INSERT INTO audit_logs(id) VALUES (1) RETURNING id") {
		t.Fatal("expected INSERT ... RETURNING to try query-first")
	}
	if !shouldTryQueryResultFirst("sqlserver", "UPDATE users SET name = 'next' OUTPUT inserted.id WHERE id = 1") {
		t.Fatal("expected SQL Server OUTPUT DML to try query-first")
	}
}

func TestShouldTryQueryResultFirst_TreatsWrappedMessageBlocksAsQueryFirst(t *testing.T) {
	if !shouldTryQueryResultFirst("sqlserver", "IF 1 = 1 EXEC dbo.p_get_select @name = 'demo'") {
		t.Fatal("expected control-flow wrapped SQL Server procedure call to try query-first")
	}
	if !shouldTryQueryResultFirst("sqlserver", "BEGIN PRINT 'done'; END") {
		t.Fatal("expected SQL Server BEGIN/PRINT block to try query-first")
	}
	if !shouldTryQueryResultFirst("postgres", "DO $$ BEGIN RAISE NOTICE 'done'; END $$") {
		t.Fatal("expected PostgreSQL DO/RAISE NOTICE block to try query-first")
	}
}

func TestShouldTryQueryResultFirst_DoesNotMisclassifyPlainSQLServerDML(t *testing.T) {
	if shouldTryQueryResultFirst("sqlserver", "UPDATE users SET name = 'next' WHERE id = 1") {
		t.Fatal("plain SQL Server UPDATE should not try query-first")
	}
}

func TestShouldTryQueryResultFirst_TreatsDataChangingCTESelectAsQueryFirst(t *testing.T) {
	query := "WITH moved AS (DELETE FROM audit_logs WHERE created_at < NOW() RETURNING id) SELECT * FROM moved"
	if !shouldTryQueryResultFirst("postgres", query) {
		t.Fatal("data-changing CTE ending in SELECT should try query-first to preserve returned rows")
	}
}

func TestIsReadOnlySQLQuery_ElasticsearchUsesConsolePolicy(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  bool
	}{
		{name: "search", query: `POST /events/_search
{"query":{"match_all":{}}}`, want: true},
		{name: "json dsl", query: `{"query":{"term":{"level":"error"}}}`, want: true},
		{name: "document write", query: `PUT /events/_doc/42
{"level":"error"}`, want: false},
		{name: "scripted search", query: `POST /events/_search
{"script_fields":{"value":{"script":{"source":"1"}}}}`, want: false},
		{name: "blocked endpoint", query: `GET /_nodes`, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isReadOnlySQLQuery("elasticsearch", test.query); got != test.want {
				t.Fatalf("isReadOnlySQLQuery(elasticsearch, %q) = %v, want %v", test.query, got, test.want)
			}
		})
	}
}
