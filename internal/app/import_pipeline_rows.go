package app

import (
	"fmt"
	"sort"
	"strings"
)

func buildImportInsertQuery(dbType, tableName string, columns []string, row map[string]interface{}, columnTypes importColumnTypeLookup) (string, error) {
	return buildImportInsertQueryWithConflict(
		dbType,
		tableName,
		columns,
		row,
		columnTypes,
		importConflictPolicyStop,
		nil,
	)
}

func buildImportInsertQueryWithConflict(
	dbType string,
	tableName string,
	columns []string,
	row map[string]interface{},
	columnTypes importColumnTypeLookup,
	conflictPolicy string,
	conflictKeyColumns []string,
) (string, error) {
	conflictPolicy = normalizeImportConflictPolicy(conflictPolicy)
	if err := validateImportConflictPolicyForDB(dbType, ImportFileOptions{
		ConflictPolicy:     conflictPolicy,
		ConflictKeyColumns: conflictKeyColumns,
	}); err != nil {
		return "", err
	}
	quotedCols := make([]string, 0, len(columns))
	values := make([]string, 0, len(columns))
	usableColumns := make([]string, 0, len(columns))
	normalizedRow := normalizeImportRowForTargetColumns(row, columnTypes)
	for _, column := range columns {
		if strings.TrimSpace(column) == "" {
			continue
		}
		value, exists := normalizedRow[column]
		if !exists {
			continue
		}
		usableColumns = append(usableColumns, column)
		quotedCols = append(quotedCols, quoteIdentByType(dbType, column))
		colType := columnTypes.Resolve(column)
		values = append(values, formatImportSQLValue(dbType, colType, value))
	}
	if len(quotedCols) == 0 {
		return "", fmt.Errorf("导入文件缺少有效列头")
	}
	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		quoteQualifiedIdentByType(dbType, tableName),
		strings.Join(quotedCols, ", "),
		strings.Join(values, ", "))
	if conflictPolicy == importConflictPolicyStop {
		return query, nil
	}
	if conflictPolicy == importConflictPolicySkipDuplicates {
		if isMySQLConflictDialect(dbType) {
			// MySQL duplicates are classified by their typed error code after a
			// normal INSERT. INSERT IGNORE would also hide truncation and NOT NULL
			// errors, so it is deliberately not used here.
			return query, nil
		}
		return query + " ON CONFLICT DO NOTHING", nil
	}

	keySet := make(map[string]struct{}, len(conflictKeyColumns))
	availableColumns := make(map[string][]string, len(usableColumns))
	for _, column := range usableColumns {
		normalizedColumn := normalizeColumnName(column)
		availableColumns[normalizedColumn] = append(availableColumns[normalizedColumn], column)
	}
	quotedKeys := make([]string, 0, len(conflictKeyColumns))
	for _, key := range conflictKeyColumns {
		normalizedKey := normalizeColumnName(key)
		matches := availableColumns[normalizedKey]
		if len(matches) == 0 {
			return "", fmt.Errorf("import conflict key column %q is not present in the selected import columns", key)
		}
		if len(matches) > 1 {
			return "", fmt.Errorf("import conflict key column %q is ambiguous in the selected import columns", key)
		}
		keySet[normalizedKey] = struct{}{}
		quotedKeys = append(quotedKeys, quoteIdentByType(dbType, matches[0]))
	}
	assignments := make([]string, 0, len(usableColumns))
	for _, column := range usableColumns {
		if _, key := keySet[normalizeColumnName(column)]; key {
			continue
		}
		quoted := quoteIdentByType(dbType, column)
		if isMySQLConflictDialect(dbType) {
			assignments = append(assignments, quoted+"=VALUES("+quoted+")")
		} else {
			assignments = append(assignments, quoted+"=EXCLUDED."+quoted)
		}
	}
	if isMySQLConflictDialect(dbType) {
		if len(assignments) == 0 {
			quoted := quotedKeys[0]
			assignments = append(assignments, quoted+"=VALUES("+quoted+")")
		}
		return query + " ON DUPLICATE KEY UPDATE " + strings.Join(assignments, ", "), nil
	}
	if len(assignments) == 0 {
		return query + " ON CONFLICT (" + strings.Join(quotedKeys, ", ") + ") DO NOTHING", nil
	}
	return query + " ON CONFLICT (" + strings.Join(quotedKeys, ", ") + ") DO UPDATE SET " + strings.Join(assignments, ", "), nil
}

func importJSONColumns(row map[string]interface{}) []string {
	columns := make([]string, 0, len(row))
	for key := range row {
		if strings.TrimSpace(key) == "" {
			continue
		}
		columns = append(columns, key)
	}
	sort.Strings(columns)
	return columns
}

func cloneImportColumns(raw []string) []string {
	return append([]string(nil), raw...)
}

func hasImportUsableColumns(columns []string) bool {
	for _, column := range columns {
		if strings.TrimSpace(column) != "" {
			return true
		}
	}
	return false
}

func validateImportUniqueColumns(format string, columns []string) error {
	seen := make(map[string]string, len(columns))
	for _, column := range columns {
		normalized := normalizeColumnName(column)
		if normalized == "" {
			continue
		}
		if previous, exists := seen[normalized]; exists {
			return fmt.Errorf("%s duplicate header columns %q and %q", format, previous, column)
		}
		seen[normalized] = column
	}
	return nil
}

func buildImportRowFromValues(columns []string, values []string) map[string]interface{} {
	return buildImportRowFromValuesWithOptions(columns, values, ImportFileOptions{})
}

func buildImportRowFromValuesWithOptions(columns []string, values []string, options ImportFileOptions) map[string]interface{} {
	row := make(map[string]interface{}, len(columns))
	for idx, column := range columns {
		if strings.TrimSpace(column) == "" {
			continue
		}
		if idx >= len(values) {
			row[column] = nil
			continue
		}
		row[column] = normalizeImportStringValue(values[idx], options)
	}
	return row
}

func normalizeImportStringValue(value string, options ImportFileOptions) interface{} {
	if options.NullToken != nil {
		if value == *options.NullToken {
			return nil
		}
	} else if value == "NULL" {
		// Preserve the legacy import wrapper's historical NULL convention when
		// no explicit token was supplied.
		return nil
	}
	if options.EmptyStringAsNull && value == "" {
		return nil
	}
	return value
}

func normalizeImportMapRow(columns []string, raw map[string]interface{}) map[string]interface{} {
	return normalizeImportMapRowWithOptions(columns, raw, ImportFileOptions{})
}

func normalizeImportMapRowWithOptions(columns []string, raw map[string]interface{}, options ImportFileOptions) map[string]interface{} {
	row := make(map[string]interface{}, len(columns))
	for _, column := range columns {
		if value, ok := raw[column]; ok {
			if text, isText := value.(string); isText {
				row[column] = normalizeImportStringValue(text, options)
			} else {
				row[column] = value
			}
			continue
		}
		row[column] = nil
	}
	return row
}

func cloneImportRow(row map[string]interface{}) map[string]interface{} {
	if row == nil {
		return nil
	}
	cloned := make(map[string]interface{}, len(row))
	for key, value := range row {
		cloned[key] = value
	}
	return cloned
}

func cloneImportRows(rows []map[string]interface{}) []map[string]interface{} {
	if len(rows) == 0 {
		return nil
	}
	cloned := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		cloned = append(cloned, cloneImportRow(row))
	}
	return cloned
}
