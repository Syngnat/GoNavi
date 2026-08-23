package app

import (
	"strings"
	"testing"
)

func TestPreflightSQLImportRejectsPostgresCopyFromStdin(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("COPY public.demo (id, name) FROM STDIN;\n1\talpha\n\\.\n"), "postgres")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if result.Safe || result.Reason == nil {
		t.Fatalf("result = %#v, want a structured rejection", result)
	}
	if result.Reason.Code != SQLImportPreflightPostgresCopyFromStdin {
		t.Fatalf("reason code = %q, want %q", result.Reason.Code, SQLImportPreflightPostgresCopyFromStdin)
	}
}

func TestPreflightSQLImportRejectsPsqlMetaCommand(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("\\connect reporting\nSELECT 1;\n"), "postgres")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if result.Safe || result.Reason == nil {
		t.Fatalf("result = %#v, want a structured rejection", result)
	}
	if result.Reason.Code != SQLImportPreflightReasonCode("psql_meta_command") {
		t.Fatalf("reason code = %q, want psql_meta_command", result.Reason.Code)
	}
}

func TestPreflightSQLImportRejectsInlinePsqlMetaCommand(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("SELECT 1 \\g\n"), "postgres")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if result.Safe || result.Reason == nil || result.Reason.Code != SQLImportPreflightPsqlMetaCommand {
		t.Fatalf("result = %#v, want inline psql meta-command rejection", result)
	}
}

func TestPreflightSQLImportRejectsSQLCmdInclude(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader(":r child.sql\nSELECT 1;\n"), "sqlserver")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if result.Safe || result.Reason == nil {
		t.Fatalf("result = %#v, want a structured rejection", result)
	}
	if result.Reason.Code != SQLImportPreflightReasonCode("sqlcmd_command") {
		t.Fatalf("reason code = %q, want sqlcmd_command", result.Reason.Code)
	}
}

func TestPreflightSQLImportRejectsMySQLSourceCommand(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("SOURCE child.sql;\n"), "mysql")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if result.Safe || result.Reason == nil {
		t.Fatalf("result = %#v, want a structured rejection", result)
	}
	if result.Reason.Code != SQLImportPreflightReasonCode("mysql_client_command") {
		t.Fatalf("reason code = %q, want mysql_client_command", result.Reason.Code)
	}
}

func TestPreflightSQLImportRejectsInlineMySQLClientCommand(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("SELECT 1 \\G\n"), "mysql")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if result.Safe || result.Reason == nil || result.Reason.Code != SQLImportPreflightMySQLClientCommand {
		t.Fatalf("result = %#v, want inline mysql client-command rejection", result)
	}
}

func TestPreflightSQLImportRejectsSQLPlusInclude(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("@child.sql\nSELECT 1 FROM dual;\n"), "oracle")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if result.Safe || result.Reason == nil {
		t.Fatalf("result = %#v, want a structured rejection", result)
	}
	if result.Reason.Code != SQLImportPreflightReasonCode("sqlplus_command") {
		t.Fatalf("reason code = %q, want sqlplus_command", result.Reason.Code)
	}
	if result.Reason.Directive != "@" {
		t.Fatalf("directive = %q, want redacted include marker", result.Reason.Directive)
	}
}

func TestPreflightSQLImportRejectsSQLiteDotCommand(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader(".read child.sql\nSELECT 1;\n"), "sqlite")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if result.Safe || result.Reason == nil || result.Reason.Code != SQLImportPreflightReasonCode("sqlite_client_command") {
		t.Fatalf("result = %#v, want sqlite client-command rejection", result)
	}
}

func TestPreflightSQLImportIgnoresClientCommandTextInsidePostgresDollarQuote(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("SELECT $$line one\n\\connect not_a_command\nline three$$;\n"), "postgres")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if !result.Safe || result.Reason != nil {
		t.Fatalf("result = %#v, want quoted client-command text to remain safe", result)
	}
}

func TestPreflightSQLImportDoesNotTreatQuotedStdinAsCopyProtocol(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("COPY demo FROM 'stdin';\n"), "postgres")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if !result.Safe || result.Reason != nil {
		t.Fatalf("result = %#v, want quoted filename to remain ordinary SQL", result)
	}
}

func TestPreflightSQLImportDoesNotTreatCopyQueryTableAsStdinProtocol(t *testing.T) {
	result, err := PreflightSQLImport(strings.NewReader("COPY (SELECT * FROM stdin) TO STDOUT;\n"), "postgres")
	if err != nil {
		t.Fatalf("preflight SQL import: %v", err)
	}
	if !result.Safe || result.Reason != nil {
		t.Fatalf("result = %#v, want COPY query to remain ordinary SQL", result)
	}
}
