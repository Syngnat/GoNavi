package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/shared/i18n"
)

func methodsFileFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("methods_file.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

func TestExternalSQLFileBackendCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"file.backend.dialog.select_sql_directory",
		"file.backend.dialog.select_sql_file",
		"file.backend.error.create_directory_failed",
		"file.backend.error.create_sql_file_failed",
		"file.backend.error.delete_sql_directory_failed",
		"file.backend.error.delete_sql_file_failed",
		"file.backend.error.directory_exists",
		"file.backend.error.directory_name_no_separator",
		"file.backend.error.directory_name_required",
		"file.backend.error.directory_path_required",
		"file.backend.error.file_path_required",
		"file.backend.error.read_directory_info_failed",
		"file.backend.error.read_file_info_failed",
		"file.backend.error.read_target_directory_info_failed",
		"file.backend.error.read_target_file_info_failed",
		"file.backend.error.rename_directory_failed",
		"file.backend.error.rename_sql_file_failed",
		"file.backend.error.selected_path_not_directory",
		"file.backend.error.selected_path_not_sql_file",
		"file.backend.error.sql_file_exists",
		"file.backend.error.sql_file_extension_required",
		"file.backend.error.sql_file_name_no_separator",
		"file.backend.error.sql_file_name_required",
		"file.backend.error.target_directory_exists",
		"file.backend.error.target_file_overwrite_confirmation_required",
		"file.backend.error.target_sql_file_exists",
		"file.backend.error.write_failed",
		"file.backend.filter.all_files_pattern",
		"file.backend.filter.sql_files",
		"query_editor.action.export_sql_file",
		"query_editor.message.export_sql_file_success",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing external SQL file key %q", language, key)
			}
		}
	}
}

func TestExportDriverAgentGuardCatalogKeyExists(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		if strings.TrimSpace(catalog["file.backend.error.export_driver_agent_streaming_required"]) == "" {
			t.Fatalf("%s catalog missing export driver-agent streaming key", language)
		}
	}
}

func TestFileSelectorDialogCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"file.backend.dialog.select_ssh_key_file",
		"file.backend.dialog.select_tls_certificate_file",
		"file.backend.dialog.select_ca_server_certificate_file",
		"file.backend.dialog.select_client_certificate_file",
		"file.backend.dialog.select_client_private_key_file",
		"file.backend.dialog.select_database_file",
		"file.backend.dialog.select_sqlite_file",
		"file.backend.dialog.select_duckdb_file",
		"file.backend.filter.private_key_files",
		"file.backend.filter.certificate_files",
		"file.backend.filter.database_files",
		"file.backend.filter.sqlite_files",
		"file.backend.filter.duckdb_files",
		"file.backend.filter.all_files",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing file selector key %q", language, key)
			}
		}
	}
}

func TestImportDataBackendCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"file.backend.dialog.import_data",
		"file.backend.error.import_csv_empty_or_missing_header",
		"file.backend.error.import_csv_open_failed",
		"file.backend.error.import_csv_read_failed",
		"file.backend.error.import_excel_empty_or_missing_header",
		"file.backend.error.import_excel_no_sheets",
		"file.backend.error.import_excel_parse_failed",
		"file.backend.error.import_excel_read_failed",
		"file.backend.error.import_file_empty",
		"file.backend.error.import_job_already_running",
		"file.backend.error.import_json_parse_failed",
		"file.backend.error.import_stopped_on_error",
		"file.backend.error.import_unsupported_format",
		"file.backend.filter.data_files",
		"file.backend.message.import_cancelled",
		"file.backend.message.import_no_data",
		"file.backend.message.import_row_failed",
		"file.backend.message.import_summary",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing import data key %q", language, key)
			}
		}
	}
}

func TestApplyChangesCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"file.backend.error.batch_commit_unsupported",
		"file.backend.message.transaction_committed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing table edit commit key %q", language, key)
			}
		}
	}
}

func TestTableDataClearCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"file.backend.error.table_data_batch_limit",
		"file.backend.error.table_data_clear_failed",
		"file.backend.error.table_data_clear_failed_partial",
		"file.backend.error.table_data_mode_unsupported",
		"file.backend.error.table_data_no_tables",
		"file.backend.error.table_data_truncate_failed",
		"file.backend.error.table_data_truncate_failed_partial",
		"file.backend.error.table_data_truncate_unsupported",
		"file.backend.message.table_data_clear_succeeded",
		"file.backend.message.table_data_truncate_succeeded",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing table data clear key %q", language, key)
			}
		}
	}
}

func TestExportBackendCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"file.backend.dialog.export_connections",
		"file.backend.dialog.export_data",
		"file.backend.dialog.export_database_sql",
		"file.backend.dialog.export_query_result",
		"file.backend.dialog.export_table",
		"file.backend.dialog.export_tables_sql",
		"file.backend.error.database_name_required",
		"file.backend.error.invalid_export_mode",
		"file.backend.error.query_required",
		"file.backend.error.schema_export_no_objects",
		"file.backend.error.schema_name_required",
		"file.backend.error.select_with_query_required",
		"file.backend.dialog.select_batch_export_directory",
		"file.backend.error.target_file_overwrite_confirmation_required",
		"file.backend.error.write_failed",
		"file.backend.filter.connection_package",
		"file.backend.message.export_completed",
		"data_export.progress.stage.preparing_export",
		"data_export.progress.stage.exporting_sql_file",
		"data_export.progress.stage.preparing_batch_tables_export",
		"data_export.progress.stage.preparing_batch_databases_export",
		"data_export.progress.stage.exporting_item_with_progress",
		"data_export.progress.stage.querying_data",
		"data_export.progress.stage.writing_file",
		"data_export.progress.stage.finalizing_file_write",
		"data_export.progress.stage.finalizing_xlsx_package",
		"data_export.progress.stage.finalizing_csv_write",
		"data_export.progress.stage.export_failed",
		"data_export.workbench.target.batch_databases",
		"data_export.workbench.target.batch_tables",
		"data_export.workbench.target.current_database",
		"sidebar.message.select_database_required",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing export key %q", language, key)
			}
		}
	}
}

func TestExecuteSQLFileMessageCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"file.backend.error.file_path_empty",
		"file.backend.error.open_file_failed",
		"file.backend.error.read_file_error_summary",
		"file.backend.error.sql_file_batch_execution_failed",
		"file.backend.error.sql_file_batch_rollback_failed",
		"file.backend.error.sql_file_execution_failed_summary",
		"file.backend.error.sql_file_statement_execution_failed",
		"file.backend.error.sql_file_stopped_on_error_summary",
		"file.backend.error.sql_file_unclosed_transaction",
		"file.backend.error.task_not_found",
		"file.backend.message.cancel_requested",
		"file.backend.message.execution_cancelled",
		"file.backend.message.execution_completed",
		"file.backend.message.execution_error_detail_header",
		"file.backend.message.execution_more_errors",
		"file.backend.message.statement_failed",
		"file.backend.message.user_cancelled",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing SQL file execution key %q", language, key)
			}
		}
	}
}

func TestAppLogBackendMessageCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"file.backend.error.app_log_file_not_found",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing app log key %q", language, key)
			}
		}
	}
}
