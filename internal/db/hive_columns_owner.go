//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

// Called only by this session's worker, including while another completed
// operation is waiting to fetch rows. Never call session.run recursively here.
func (s *hiveSession) hiveColumnsOnOwner(ctx context.Context, database, table string) ([]connection.ColumnDefinition, error) {
	qualified := hiveQualifiedName(database, table)
	rows, fields, err := s.hiveQueryOnOwner(ctx, "DESCRIBE "+qualified)
	if err != nil {
		return nil, err
	}
	columns, err := hiveDescribeColumns(rows, fields)
	if err != nil {
		return nil, err
	}

	rows, fields, err = s.hiveQueryOnOwner(ctx, "DESCRIBE FORMATTED "+qualified)
	if err != nil {
		return nil, err
	}
	if s.config.family != "impala" {
		return s.hiveMergeNullabilityOnOwner(ctx, qualified, columns, rows, fields)
	}
	partitions, found, err := hiveFormattedPartitionNames(rows, fields)
	if err != nil {
		return nil, err
	}
	if !found {
		rows, fields, err = s.hiveQueryOnOwner(ctx, "SHOW CREATE TABLE "+qualified)
		if err != nil {
			return nil, err
		}
		if len(fields) == 0 {
			return nil, fmt.Errorf("Impala returned no CREATE metadata for partition verification")
		}
		lines := make([]string, 0, len(rows))
		for _, row := range rows {
			lines = append(lines, hiveRowText(row, fields[0]))
		}
		partitions, err = hivesql.PartitionColumnsFromDDL(strings.Join(lines, "\n"))
		if err != nil {
			return nil, err
		}
	}
	known := make(map[string]bool, len(columns))
	for _, column := range columns {
		known[strings.ToLower(column.Name)] = true
	}
	for _, partition := range partitions {
		if !known[strings.ToLower(partition)] {
			return nil, fmt.Errorf("Impala partition column %q is absent from DESCRIBE", partition)
		}
	}
	for i := range columns {
		for _, partition := range partitions {
			if strings.EqualFold(columns[i].Name, partition) {
				columns[i].Extra = "partition"
			}
		}
	}
	return s.hiveMergeNullabilityOnOwner(ctx, qualified, columns, rows, fields)
}
func (s *hiveSession) hiveQueryOnOwner(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	collector := &hiveRowCollector{}
	_, err := s.execute(ctx, query, collector)
	return collector.rows, collector.names, err
}
func hiveFormattedPartitionNames(rows []map[string]interface{}, fields []string) ([]string, bool, error) {
	if len(fields) < 2 {
		return nil, false, fmt.Errorf("Impala formatted metadata has no type column")
	}
	found := false
	var names []string
	for _, row := range rows {
		name := strings.TrimSpace(hiveRowText(row, fields[0]))
		lower := strings.ToLower(name)
		if strings.Contains(lower, "partition information") {
			found = true
			continue
		}
		if !found {
			continue
		}
		if strings.HasPrefix(lower, "# detailed") || strings.HasPrefix(lower, "# storage") {
			break
		}
		if name == "" || strings.HasPrefix(name, "#") {
			continue
		}
		typ := strings.TrimSpace(hiveRowText(row, fields[1]))
		if typ == "" {
			continue
		}
		if _, err := hivesql.ParseType(typ); err != nil {
			return nil, true, err
		}
		names = append(names, name)
	}
	return names, found, nil
}
func (s *hiveSession) hiveMergeNullabilityOnOwner(ctx context.Context, qualified string, columns []connection.ColumnDefinition, rows []map[string]interface{}, fields []string) ([]connection.ColumnDefinition, error) {
	names := hiveFormattedNotNullNames(rows, fields)
	if len(names) == 0 && s.config.family == "hive" {
		return columns, nil
	}
	ddlRows, ddlFields, err := s.hiveQueryOnOwner(ctx, "SHOW CREATE TABLE "+qualified)
	if err != nil {
		return nil, err
	}
	if len(ddlFields) == 0 {
		return nil, fmt.Errorf("Hive returned no DDL for NOT NULL verification")
	}
	lines := make([]string, 0, len(ddlRows))
	for _, row := range ddlRows {
		lines = append(lines, hiveRowText(row, ddlFields[0]))
	}
	enforced, err := hivesql.ValidateNotNullMetadata(names, strings.Join(lines, "\n"))
	if err != nil {
		return nil, err
	}
	for i := range columns {
		if enforced[strings.ToLower(columns[i].Name)] {
			columns[i].Nullable = "NO"
		}
	}
	return columns, nil
}
func hiveFormattedNotNullNames(rows []map[string]interface{}, fields []string) []string {
	if len(fields) < 2 {
		return nil
	}
	section := false
	var names []string
	for _, row := range rows {
		label := strings.TrimSpace(hiveRowText(row, fields[0]))
		lower := strings.ToLower(label)
		if strings.HasPrefix(lower, "#") {
			section = strings.Contains(lower, "not null constraint")
			continue
		}
		if !section || !strings.HasPrefix(lower, "column name:") {
			continue
		}
		name := strings.TrimSpace(label[len("Column Name:"):])
		if name == "" {
			name = strings.TrimSpace(hiveRowText(row, fields[1]))
		}
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}
