//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

// ApplyChanges submits prevalidated autocommit statements; it is not an atomic batch.
func (h *HiveDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return h.ApplyChangesContext(metadataContextFor(h), tableName, changes)
}

// ApplyChangesContext validates every value and operation before the first write.
// A failure after a committed statement is marked no-retry/unknown for the batch.
func (h *HiveDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if ctx == nil {
		return fmt.Errorf("Hive write context is nil")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(changes.Inserts)+len(changes.Updates)+len(changes.Deletes) == 0 {
		return nil
	}
	capability, statements, err := h.prepareHiveChanges(ctx, tableName, changes)
	if err != nil {
		return err
	}
	pinned, err := h.OpenSessionExecer(ctx)
	if err != nil {
		return err
	}
	defer pinned.Close()
	// The job owns this session, so dynamic partition configuration cannot leak to
	// editor queries. Impala does not understand Hive's dynamic-partition setting.
	if len(capability.PartitionColumns) > 0 && capability.Family != "impala" {
		if _, err = pinned.ExecContext(ctx, "SET hive.exec.dynamic.partition=true"); err != nil {
			return err
		}
		if _, err = pinned.ExecContext(ctx, "SET hive.exec.dynamic.partition.mode=nonstrict"); err != nil {
			return err
		}
	}
	for index, statement := range statements {
		if _, err = pinned.ExecContext(ctx, statement); err != nil {
			if index > 0 {
				return MarkWriteOutcomeUnknown(fmt.Errorf("Hive batch partially committed (%d of %d statements): %w", index, len(statements), err))
			}
			return markWriteOutcomeUnknownIfAmbiguous(ctx, err)
		}
	}
	return nil
}

func hivePlanChanges(table string, columns []connection.ColumnDefinition, capability HiveTableWriteCapabilities, changes connection.ChangeSet) ([]string, error) {
	if len(changes.Inserts)+len(changes.Updates)+len(changes.Deletes) > 100000 {
		return nil, fmt.Errorf("Hive batch exceeds 100000 mutations")
	}
	definitions := hiveColumnsByName(columns)
	partitions := map[string]bool{}
	for _, name := range capability.PartitionColumns {
		partitions[name] = true
	}
	statements := make([]string, 0, len(changes.Deletes)+len(changes.Updates)+len(changes.Inserts)/128+1)
	totalBytes := 0
	appendStatement := func(statement string) error {
		totalBytes += len(statement)
		if totalBytes > 64<<20 {
			return fmt.Errorf("Hive batch SQL exceeds 64 MiB")
		}
		statements = append(statements, statement)
		return nil
	}
	for _, keys := range changes.Deletes {
		predicate, err := hiveMutationPredicate(definitions, keys)
		if err != nil {
			return nil, err
		}
		if err = appendStatement("DELETE FROM " + table + " WHERE " + predicate); err != nil {
			return nil, err
		}
	}
	for _, change := range changes.Updates {
		predicate, err := hiveMutationPredicate(definitions, change.Keys)
		if err != nil {
			return nil, err
		}
		if len(change.Values) == 0 {
			return nil, fmt.Errorf("Hive update has no values")
		}
		names := hiveSortedKeys(change.Values)
		assignments := make([]string, len(names))
		for i, name := range names {
			column, found := definitions[name]
			if !found {
				return nil, fmt.Errorf("unknown Hive update column %q", name)
			}
			if partitions[name] {
				return nil, fmt.Errorf("Hive partition columns cannot be updated")
			}
			literal, err := hivesql.Value(column.Type, change.Values[name])
			if err != nil {
				return nil, fmt.Errorf("Hive update column %q: %w", name, err)
			}
			assignments[i] = hivesql.QuoteIdentifier(name) + " = " + literal
		}
		if err = appendStatement("UPDATE " + table + " SET " + strings.Join(assignments, ", ") + " WHERE " + predicate); err != nil {
			return nil, err
		}
	}
	inserts, err := hivePlanInserts(table, columns, capability, changes.Inserts)
	if err != nil {
		return nil, err
	}
	for _, statement := range inserts {
		if err = appendStatement(statement); err != nil {
			return nil, err
		}
	}
	return statements, nil
}

func hiveMutationPredicate(definitions map[string]connection.ColumnDefinition, keys map[string]interface{}) (string, error) {
	if len(keys) == 0 {
		return "", fmt.Errorf("Hive mutations require an explicit nonempty row predicate")
	}
	names := hiveSortedKeys(keys)
	parts := make([]string, len(names))
	for i, name := range names {
		column, found := definitions[name]
		if !found {
			return "", fmt.Errorf("unknown Hive predicate column %q", name)
		}
		t, err := hivesql.ParseType(column.Type)
		if err != nil {
			return "", err
		}
		if t.Complex() {
			return "", fmt.Errorf("Hive collection columns cannot locate mutable rows")
		}
		if keys[name] == nil {
			parts[i] = hivesql.QuoteIdentifier(name) + " IS NULL"
			continue
		}
		literal, err := hivesql.Value(column.Type, keys[name])
		if err != nil {
			return "", err
		}
		parts[i] = hivesql.QuoteIdentifier(name) + " = " + literal
	}
	return strings.Join(parts, " AND "), nil
}

func hivePlanInserts(table string, columns []connection.ColumnDefinition, capability HiveTableWriteCapabilities, rows []map[string]interface{}) ([]string, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("Hive insert requires table columns")
	}
	definitions := hiveColumnsByName(columns)
	partitionNames := capability.PartitionColumns
	partitions := map[string]bool{}
	for _, name := range partitionNames {
		partitions[name] = true
	}
	ordered := make([]connection.ColumnDefinition, 0, len(columns))
	for _, column := range columns {
		if !partitions[column.Name] {
			ordered = append(ordered, column)
		}
	}
	for _, name := range partitionNames {
		column, ok := definitions[name]
		if !ok {
			return nil, fmt.Errorf("unknown Hive partition column %q", name)
		}
		ordered = append(ordered, column)
	}
	prefix := "INSERT INTO TABLE " + table
	if len(partitionNames) > 0 {
		quoted := make([]string, len(partitionNames))
		for i, name := range partitionNames {
			quoted[i] = hivesql.QuoteIdentifier(name)
		}
		prefix += " PARTITION (" + strings.Join(quoted, ", ") + ")"
	}
	prefix += " "
	var statements []string
	var selects []string
	size := len(prefix)
	flush := func() {
		if len(selects) > 0 {
			statements = append(statements, prefix+strings.Join(selects, " UNION ALL "))
			selects = nil
			size = len(prefix)
		}
	}
	for _, row := range rows {
		for name := range row {
			if _, ok := definitions[name]; !ok {
				return nil, fmt.Errorf("unknown Hive insert column %q", name)
			}
		}
		values := make([]string, len(ordered))
		for i, column := range ordered {
			value, found := row[column.Name]
			if !found && (column.Nullable == "NO" || partitions[column.Name]) {
				return nil, fmt.Errorf("missing required Hive column %q", column.Name)
			}
			literal, err := hivesql.Value(column.Type, value)
			if err != nil {
				return nil, fmt.Errorf("Hive insert column %q: %w", column.Name, err)
			}
			values[i] = literal
		}
		selectSQL := "SELECT " + strings.Join(values, ", ")
		if len(selectSQL) > 4<<20 {
			return nil, fmt.Errorf("Hive insert row SQL exceeds 4 MiB")
		}
		if len(selects) >= 128 || size+len(selectSQL) > 1<<20 {
			flush()
		}
		selects = append(selects, selectSQL)
		size += len(selectSQL) + 11
	}
	flush()
	return statements, nil
}

func hiveSortedKeys(values map[string]interface{}) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
