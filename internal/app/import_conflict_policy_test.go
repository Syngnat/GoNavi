package app

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

type conflictPolicyImportDB struct {
	db.Database
	affected int64
	err      error
	queries  []string
}

func (database *conflictPolicyImportDB) Exec(query string) (int64, error) {
	database.queries = append(database.queries, query)
	return database.affected, database.err
}

func TestBuildImportInsertQueryWithConflictPostgresUpsert(t *testing.T) {
	query, err := buildImportInsertQueryWithConflict(
		"postgres",
		"public.users",
		[]string{"id", "name"},
		map[string]interface{}{"id": 1, "name": "alice"},
		newImportColumnTypeLookup(nil),
		importConflictPolicyUpsert,
		[]string{"id"},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := `INSERT INTO "public"."users" ("id", "name") VALUES (1, 'alice') ON CONFLICT ("id") DO UPDATE SET "name"=EXCLUDED."name"`
	if query != want {
		t.Fatalf("query = %q, want %q", query, want)
	}
}

func TestBuildImportInsertQueryWithConflictSQLiteSkipsDuplicates(t *testing.T) {
	query, err := buildImportInsertQueryWithConflict(
		"sqlite",
		"users",
		[]string{"id"},
		map[string]interface{}{"id": 1},
		newImportColumnTypeLookup(nil),
		importConflictPolicySkipDuplicates,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(query, " ON CONFLICT DO NOTHING") {
		t.Fatalf("unexpected skip query: %q", query)
	}
}

func TestBuildImportInsertQueryWithConflictPreservesFractionalSeconds(t *testing.T) {
	query, err := buildImportInsertQueryWithConflict(
		"postgres",
		"events",
		[]string{"id", "created_at", "local_time", "zoned_at"},
		map[string]interface{}{
			"id":         1,
			"created_at": "2026-08-08 12:34:56.123456",
			"local_time": "12:34:56.120000",
			"zoned_at":   "2026-08-08T12:34:56.123456+08:00",
		},
		newImportColumnTypeLookup([]connection.ColumnDefinition{
			{Name: "id", Type: "bigint"},
			{Name: "created_at", Type: "timestamp(6)"},
			{Name: "local_time", Type: "time(6)"},
			{Name: "zoned_at", Type: "timestamp(6) with time zone"},
		}),
		importConflictPolicyUpsert,
		[]string{"id"},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`'2026-08-08 12:34:56.123456'`,
		`'12:34:56.120000'`,
		`'2026-08-08 12:34:56.123456+08:00'`,
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("query lost temporal precision %s: %s", want, query)
		}
	}
}

func TestBuildImportInsertQueryWithConflictMarshalsNestedJSONValues(t *testing.T) {
	query, err := buildImportInsertQueryWithConflict(
		"postgres",
		"events",
		[]string{"id", "metadata", "tags"},
		map[string]interface{}{
			"id": 1,
			"metadata": map[string]interface{}{
				"label":  "O'Reilly",
				"nested": map[string]interface{}{"a": 1},
			},
			"tags": []interface{}{"alpha", map[string]interface{}{"enabled": true}},
		},
		newImportColumnTypeLookup([]connection.ColumnDefinition{
			{Name: "id", Type: "bigint"},
			{Name: "metadata", Type: "jsonb"},
			{Name: "tags", Type: "jsonb"},
		}),
		importConflictPolicyUpsert,
		[]string{"id"},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`'{"label":"O''Reilly","nested":{"a":1}}'`,
		`'["alpha",{"enabled":true}]'`,
	} {
		if !strings.Contains(query, want) {
			t.Fatalf("query did not contain safely quoted JSON %s: %s", want, query)
		}
	}
	if strings.Contains(query, "map[") {
		t.Fatalf("nested JSON was formatted with fmt.Sprint: %s", query)
	}
}

func TestImportDatabaseRowWriterClassifiesMySQLDuplicateAsSkipped(t *testing.T) {
	database := &conflictPolicyImportDB{err: &mysqlDriver.MySQLError{Number: 1062, Message: "Duplicate entry 'private' for key 'PRIMARY'"}}
	writer := newImportDatabaseRowWriterWithOptions(database, "mysql", "users", newImportColumnTypeLookup(nil), ImportFileOptions{
		ConflictPolicy: importConflictPolicySkipDuplicates,
	})
	writer.SetColumns([]string{"id"})
	outcome, err := writer.ApplyOneWithOutcome(map[string]interface{}{"id": 1})
	if err != nil {
		t.Fatalf("duplicate should be skipped: %v", err)
	}
	if outcome != importRowApplySkipped {
		t.Fatalf("outcome = %q, want skipped", outcome)
	}
	if writer.BatchEnabled() {
		t.Fatal("conflict policies must not use ambiguous BatchApplier writes")
	}
}

func TestImportDatabaseRowWriterDoesNotHideNonDuplicateMySQLError(t *testing.T) {
	database := &conflictPolicyImportDB{err: &mysqlDriver.MySQLError{Number: 1048, Message: "Column cannot be null"}}
	writer := newImportDatabaseRowWriterWithOptions(database, "mysql", "users", newImportColumnTypeLookup(nil), ImportFileOptions{
		ConflictPolicy: importConflictPolicySkipDuplicates,
	})
	writer.SetColumns([]string{"id"})
	if _, err := writer.ApplyOneWithOutcome(map[string]interface{}{"id": nil}); err == nil {
		t.Fatal("non-duplicate database error must not be skipped")
	}
}

func TestImportBatchConsumerReportsSkippedRowsSeparately(t *testing.T) {
	database := &conflictPolicyImportDB{affected: 0}
	writer := newImportDatabaseRowWriterWithOptions(database, "sqlite", "users", newImportColumnTypeLookup(nil), ImportFileOptions{
		ConflictPolicy: importConflictPolicySkipDuplicates,
	})
	consumer := newImportBatchConsumer(writer, 1000, 1, true, true, nil)
	if err := consumer.SetColumns([]string{"id"}); err != nil {
		t.Fatal(err)
	}
	if err := consumer.ConsumeRow(map[string]interface{}{"id": 1}); err != nil {
		t.Fatal(err)
	}
	if err := consumer.Flush(); err != nil {
		t.Fatal(err)
	}
	result := consumer.Result()
	if result.Success != 0 || result.Skipped != 1 || result.Failed != 0 || result.Total != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestValidateImportConflictPolicyRejectsUnsupportedDialectAndMissingKeys(t *testing.T) {
	if err := validateImportConflictPolicyForDB("oracle", ImportFileOptions{ConflictPolicy: importConflictPolicyUpsert, ConflictKeyColumns: []string{"id"}}); err == nil {
		t.Fatal("Oracle upsert must fail closed until a safe implementation exists")
	}
	if err := validateImportConflictPolicyForDB("postgres", ImportFileOptions{ConflictPolicy: importConflictPolicyUpsert}); err == nil {
		t.Fatal("upsert without conflict keys must fail")
	}
	if err := validateImportConflictPolicyForDB("mysql", ImportFileOptions{ConflictPolicy: importConflictPolicySkipDuplicates}); err != nil {
		t.Fatalf("MySQL skip_duplicates should be supported: %v", err)
	}
	if err := validateImportConflictPolicyForDB("mysql", ImportFileOptions{
		ConflictPolicy:     importConflictPolicyUpsert,
		ConflictKeyColumns: []string{"id"},
	}); err == nil {
		t.Fatal("MySQL upsert must fail closed because ON DUPLICATE KEY cannot target the selected conflict key")
	}
}

func TestImportDatabaseRowWriterRejectsMissingConflictKeyBeforeWriting(t *testing.T) {
	database := &conflictPolicyImportDB{}
	writer := newImportDatabaseRowWriterWithOptions(database, "postgres", "users", newImportColumnTypeLookup(nil), ImportFileOptions{
		ConflictPolicy:     importConflictPolicyUpsert,
		ConflictKeyColumns: []string{"id"},
	})
	consumer := newImportBatchConsumer(writer, 1000, 1, true, false, nil)
	err := consumer.SetColumns([]string{"name"})
	if err == nil || !strings.Contains(err.Error(), "id") {
		t.Fatalf("missing key error = %v", err)
	}
	if len(database.queries) != 0 {
		t.Fatalf("database was written before key validation: %v", database.queries)
	}
}

func TestMySQLDuplicateClassifierDoesNotMatchPlainTextErrors(t *testing.T) {
	if isMySQLDuplicateKeyError(errors.New("duplicate entry")) {
		t.Fatal("untyped error text must not be trusted as a duplicate-key code")
	}
}
