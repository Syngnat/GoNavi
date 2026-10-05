package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

type importRowWriter interface {
	SetColumns(columns []string)
	ApplyBatch(rows []map[string]interface{}) error
	ApplyOne(row map[string]interface{}) error
	BatchEnabled() bool
}

// importBatchContextWriter is the optional cancellation-aware batch extension.
// Keep it separate from the single-row extension so a writer can support one
// operation safely without having to implement an unrelated method.
type importBatchContextWriter interface {
	ApplyBatchContext(ctx context.Context, rows []map[string]interface{}) error
}

type importRowContextWriter interface {
	ApplyOneContext(ctx context.Context, row map[string]interface{}) error
}

type importRowApplyOutcome string

const (
	importRowApplySucceeded importRowApplyOutcome = "succeeded"
	importRowApplySkipped   importRowApplyOutcome = "skipped"
)

type importRowOutcomeWriter interface {
	ApplyOneWithOutcome(row map[string]interface{}) (importRowApplyOutcome, error)
}

type importRowContextOutcomeWriter interface {
	ApplyOneWithOutcomeContext(ctx context.Context, row map[string]interface{}) (importRowApplyOutcome, error)
}

type importRowColumnValidator interface {
	ValidateColumns(columns []string) error
}

type importColumnTypeLookup struct {
	byExactName               map[string]string
	byFoldedName              map[string][]string
	nullableByExactName       map[string]string
	nullableByFoldedName      map[string][]string
	databaseValueByExactName  map[string]bool
	databaseValueByFoldedName map[string][]bool
}

func newImportColumnTypeLookup(columns []connection.ColumnDefinition) importColumnTypeLookup {
	lookup := importColumnTypeLookup{
		byExactName:               make(map[string]string, len(columns)),
		byFoldedName:              make(map[string][]string, len(columns)),
		nullableByExactName:       make(map[string]string, len(columns)),
		nullableByFoldedName:      make(map[string][]string, len(columns)),
		databaseValueByExactName:  make(map[string]bool, len(columns)),
		databaseValueByFoldedName: make(map[string][]bool, len(columns)),
	}
	for _, column := range columns {
		name := column.Name
		if strings.TrimSpace(name) == "" {
			continue
		}
		if _, exists := lookup.byExactName[name]; !exists {
			foldedName := normalizeColumnName(name)
			lookup.byFoldedName[foldedName] = append(lookup.byFoldedName[foldedName], name)
			lookup.nullableByFoldedName[foldedName] = append(
				lookup.nullableByFoldedName[foldedName],
				strings.TrimSpace(column.Nullable),
			)
			lookup.databaseValueByFoldedName[foldedName] = append(
				lookup.databaseValueByFoldedName[foldedName],
				importColumnUsesDatabaseValue(column),
			)
		}
		lookup.byExactName[name] = strings.TrimSpace(column.Type)
		lookup.nullableByExactName[name] = strings.TrimSpace(column.Nullable)
		lookup.databaseValueByExactName[name] = importColumnUsesDatabaseValue(column)
	}
	return lookup
}

func importColumnUsesDatabaseValue(column connection.ColumnDefinition) bool {
	extra := strings.ToLower(strings.TrimSpace(column.Extra))
	return column.HasDefault || column.Default != nil ||
		strings.Contains(extra, "auto_increment") ||
		strings.Contains(extra, "identity") ||
		strings.Contains(extra, "generated")
}

func (l importColumnTypeLookup) Resolve(columnName string) string {
	if columnType, ok := l.byExactName[columnName]; ok {
		return columnType
	}
	foldedMatches := l.byFoldedName[normalizeColumnName(columnName)]
	if len(foldedMatches) != 1 {
		return ""
	}
	return l.byExactName[foldedMatches[0]]
}

func normalizeImportNullable(raw string) (bool, bool) {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "YES", "Y", "TRUE", "1", "NULLABLE":
		return true, true
	case "NO", "N", "FALSE", "0", "NOT NULL", "NOT_NULL", "NOTNULL", "REQUIRED":
		return false, true
	default:
		return false, false
	}
}

func (l importColumnTypeLookup) IsNullable(columnName string) (bool, bool) {
	raw, ok := l.nullableByExactName[columnName]
	if !ok {
		foldedMatches := l.nullableByFoldedName[normalizeColumnName(columnName)]
		if len(foldedMatches) != 1 {
			return false, false
		}
		raw = foldedMatches[0]
	}
	return normalizeImportNullable(raw)
}

func (l importColumnTypeLookup) UsesDatabaseValue(columnName string) bool {
	if usesDatabaseValue, ok := l.databaseValueByExactName[columnName]; ok {
		return usesDatabaseValue
	}
	foldedMatches := l.databaseValueByFoldedName[normalizeColumnName(columnName)]
	return len(foldedMatches) == 1 && foldedMatches[0]
}

func isBlankImportValue(value interface{}) bool {
	if value == nil {
		return true
	}
	text, ok := value.(string)
	return ok && strings.TrimSpace(text) == ""
}

func normalizeImportValueForColumn(value interface{}, nullable bool) interface{} {
	if nullable {
		if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
			return nil
		}
	}
	return value
}

func normalizeImportRowForTargetColumns(row map[string]interface{}, columnTypes importColumnTypeLookup) map[string]interface{} {
	normalized := cloneImportRow(row)
	for column, value := range normalized {
		if nullable, known := columnTypes.IsNullable(column); known {
			if nullable {
				normalized[column] = normalizeImportValueForColumn(value, true)
				continue
			}
		}
		if columnTypes.UsesDatabaseValue(column) && isBlankImportValue(value) {
			delete(normalized, column)
		}
	}
	return normalized
}

func normalizeImportRowsForTargetColumns(rows []map[string]interface{}, columnTypes importColumnTypeLookup) []map[string]interface{} {
	if len(rows) == 0 {
		return nil
	}
	normalized := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		normalized = append(normalized, normalizeImportRowForTargetColumns(row, columnTypes))
	}
	return normalized
}

type importDatabaseRowWriter struct {
	dbInst             db.Database
	applier            db.BatchApplier
	dbType             string
	tableName          string
	columns            []string
	columnTypes        importColumnTypeLookup
	conflictPolicy     string
	conflictKeyColumns []string
}

func newImportDatabaseRowWriter(dbInst db.Database, dbType, tableName string, columnTypes importColumnTypeLookup) *importDatabaseRowWriter {
	return newImportDatabaseRowWriterWithOptions(dbInst, dbType, tableName, columnTypes, ImportFileOptions{})
}

func newImportDatabaseRowWriterWithOptions(dbInst db.Database, dbType, tableName string, columnTypes importColumnTypeLookup, options ImportFileOptions) *importDatabaseRowWriter {
	writer := &importDatabaseRowWriter{
		dbInst:             dbInst,
		dbType:             dbType,
		tableName:          tableName,
		columnTypes:        columnTypes,
		conflictPolicy:     normalizeImportConflictPolicy(options.ConflictPolicy),
		conflictKeyColumns: append([]string(nil), options.ConflictKeyColumns...),
	}
	if applier, ok := dbInst.(db.BatchApplier); ok && runtimeSupportsBatchApply(dbInst) {
		writer.applier = applier
	}
	return writer
}

func (w *importDatabaseRowWriter) SetColumns(columns []string) {
	w.columns = append([]string(nil), columns...)
}

func (w *importDatabaseRowWriter) BatchEnabled() bool {
	return w.applier != nil && w.conflictPolicy == importConflictPolicyStop
}

func (w *importDatabaseRowWriter) ApplyBatch(rows []map[string]interface{}) error {
	return w.ApplyBatchContext(context.Background(), rows)
}

func (w *importDatabaseRowWriter) ApplyBatchContext(ctx context.Context, rows []map[string]interface{}) error {
	if w.applier == nil {
		return fmt.Errorf("当前数据库类型不支持批量提交")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	changes := connection.ChangeSet{Inserts: normalizeImportRowsForTargetColumns(rows, w.columnTypes)}
	if contextApplier, ok := w.applier.(db.BatchApplierContext); ok {
		return contextApplier.ApplyChangesContext(ctx, w.tableName, changes)
	}
	return w.applier.ApplyChanges(w.tableName, changes)
}

func (w *importDatabaseRowWriter) ApplyOne(row map[string]interface{}) error {
	_, err := w.ApplyOneWithOutcomeContext(context.Background(), row)
	return err
}

func (w *importDatabaseRowWriter) ApplyOneContext(ctx context.Context, row map[string]interface{}) error {
	_, err := w.ApplyOneWithOutcomeContext(ctx, row)
	return err
}

func (w *importDatabaseRowWriter) ApplyOneWithOutcome(row map[string]interface{}) (importRowApplyOutcome, error) {
	return w.ApplyOneWithOutcomeContext(context.Background(), row)
}

func (w *importDatabaseRowWriter) ApplyOneWithOutcomeContext(ctx context.Context, row map[string]interface{}) (importRowApplyOutcome, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return importRowApplySucceeded, err
	}
	if w.applier != nil && w.conflictPolicy == importConflictPolicyStop {
		changes := connection.ChangeSet{Inserts: []map[string]interface{}{normalizeImportRowForTargetColumns(row, w.columnTypes)}}
		var err error
		if contextApplier, ok := w.applier.(db.BatchApplierContext); ok {
			err = contextApplier.ApplyChangesContext(ctx, w.tableName, changes)
		} else {
			err = w.applier.ApplyChanges(w.tableName, changes)
		}
		return importRowApplySucceeded, err
	}
	query, err := buildImportInsertQueryWithConflict(
		w.dbType,
		w.tableName,
		w.columns,
		row,
		w.columnTypes,
		w.conflictPolicy,
		w.conflictKeyColumns,
	)
	if err != nil {
		return importRowApplySucceeded, err
	}
	var affected int64
	if contextExecer, ok := w.dbInst.(interface {
		ExecContext(context.Context, string) (int64, error)
	}); ok {
		affected, err = contextExecer.ExecContext(ctx, query)
	} else {
		affected, err = w.dbInst.Exec(query)
	}
	if err != nil {
		if w.conflictPolicy == importConflictPolicySkipDuplicates && isMySQLConflictDialect(w.dbType) && isMySQLDuplicateKeyError(err) {
			return importRowApplySkipped, nil
		}
		if db.IsAmbiguousWriteResponse(err) || ctx.Err() != nil {
			return importRowApplySucceeded, db.MarkWriteOutcomeUnknown(err)
		}
		return importRowApplySucceeded, err
	}
	if w.conflictPolicy == importConflictPolicySkipDuplicates && (isPostgresConflictDialect(w.dbType) || resolveDDLDBType(connection.ConnectionConfig{Type: w.dbType}) == "sqlite") && affected == 0 {
		return importRowApplySkipped, nil
	}
	return importRowApplySucceeded, nil
}

func (w *importDatabaseRowWriter) ValidateColumns(columns []string) error {
	if w == nil || w.conflictPolicy != importConflictPolicyUpsert {
		return nil
	}
	available := make(map[string]int, len(columns))
	for _, column := range columns {
		available[normalizeColumnName(column)]++
	}
	for _, key := range w.conflictKeyColumns {
		matches := available[normalizeColumnName(key)]
		if matches == 0 {
			return fmt.Errorf("import conflict key column %q is not present in the selected import columns", key)
		}
		if matches > 1 {
			return fmt.Errorf("import conflict key column %q is ambiguous in the selected import columns", key)
		}
	}
	return nil
}

func isMySQLDuplicateKeyError(err error) bool {
	var mysqlError *mysqlDriver.MySQLError
	if errors.As(err, &mysqlError) {
		return mysqlError.Number == 1062 || mysqlError.Number == 1586
	}
	// 经驱动代理（TiDB、GBase 8a、MariaDB 等）返回的错误只剩文本：按驱动的 "Error 1062 (23000): Duplicate entry" 格式识别。
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "Error 1062") || strings.Contains(message, "Error 1586")
}
