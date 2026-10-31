//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func (h *HiveDB) attachHiveSourceMetadata(ctx context.Context, session *hiveSession) error {
	return session.run(ctx, func(context.Context) error {
		session.enrichColumns = func(ctx context.Context, query, database string, columns []connection.ColumnDefinition) ([]connection.ColumnDefinition, error) {
			return h.enrichHiveSourceColumns(ctx, query, database, columns, session.hiveColumnsOnOwner)
		}
		return nil
	})
}

func (h *HiveDB) enrichHiveSourceColumns(ctx context.Context, query, database string, columns []connection.ColumnDefinition, loaders ...func(context.Context, string, string) ([]connection.ColumnDefinition, error)) ([]connection.ColumnDefinition, error) {
	if casts, ok := hivesql.ExplicitResultTypeCasts(query); ok && len(casts) == len(columns) {
		columns = append([]connection.ColumnDefinition(nil), columns...)
		for i, typ := range casts {
			if typ != "" && hiveBareComplexType(columns[i].Type) {
				if err := hivesql.ValidateReadableType(typ); err != nil {
					return nil, err
				}
				columns[i].Type = typ
			}
		}
	}
	needsSource := false
	for _, column := range columns {
		if hiveBareComplexType(column.Type) {
			needsSource = true
			break
		}
	}
	if !needsSource {
		return columns, nil
	}
	source, ok := hivesql.DirectSourceProjection(query)
	if !ok {
		return nil, fmt.Errorf("HiveServer2 omitted complex result members and source provenance is not one direct base-table projection; use an explicit scalar HEX/BASE64 projection or CAST")
	}
	columns, err := hiveProjectedResultTypes(source, columns)
	if err != nil {
		return nil, err
	}
	needsSource = false
	for _, column := range columns {
		needsSource = needsSource || hiveBareComplexType(column.Type)
	}
	if !needsSource {
		return columns, nil
	}
	if source.Database == "" {
		source.Database = database
	}
	if source.Database == "" {
		return nil, fmt.Errorf("Hive source database is uncertain after USE; qualify database.table before exporting complex values")
	}
	// Result provenance must use the owning session: a temporary table can
	// shadow a permanent table of the same name. The loader executes sequential
	// RPCs directly on this worker, never recursively calling session.run.
	// Catalog rows are not result rows: preserve cancellation/deadline but do
	// not spend the caller's interactive row budget while discovering types.
	metadataCtx := context.WithValue(ctx, rowBudgetContextKey{}, (*RowBudget)(nil))
	loader := h.GetColumnsContext
	if len(loaders) > 0 {
		loader = loaders[0]
	}
	full, err := loader(metadataCtx, source.Database, source.Table)
	if err != nil {
		return nil, err
	}
	return hiveBindSourceColumns(source, columns, full)
}

func hiveBareComplexType(raw string) bool {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "ARRAY", "MAP", "STRUCT", "UNION", "UNIONTYPE":
		return true
	}
	return false
}
func hiveBindSourceColumns(source hivesql.SourceProjection, raw, full []connection.ColumnDefinition) ([]connection.ColumnDefinition, error) {
	if source.Wildcard && len(raw) != len(full)+len(source.Columns) || !source.Wildcard && len(raw) != len(source.Columns) {
		return nil, fmt.Errorf("Hive source projection width changed; cannot infer complex result members")
	}
	enriched := append([]connection.ColumnDefinition(nil), raw...)
	for i, column := range raw {
		if !hiveBareComplexType(column.Type) {
			continue
		}
		sourceName := ""
		if !source.Wildcard {
			if source.Columns[i].Opaque {
				return nil, fmt.Errorf("Hive complex result column %q is a computed expression; cast it explicitly (CAST(x AS ARRAY<...>)) so its members are provable", column.Name)
			}
			sourceName = source.Columns[i].Name
		} else {
			for _, extra := range source.Columns {
				label := extra.Alias
				if label == "" {
					label = extra.Name
				}
				if label != "" && hiveSourceLabelMatches(column.Name, label, source) {
					sourceName = extra.Name
					break
				}
			}
		}
		found := -1
		longest := -1
		for j, candidate := range full {
			matches := sourceName != "" && strings.EqualFold(candidate.Name, sourceName)
			if source.Wildcard && sourceName == "" {
				matches = hiveSourceLabelMatches(column.Name, candidate.Name, source)
			}
			if !matches {
				continue
			}
			length := len(candidate.Name)
			if length > longest {
				found, longest = j, length
			} else if length == longest {
				return nil, fmt.Errorf("Hive source column identity is ambiguous")
			}
		}
		if found < 0 {
			return nil, fmt.Errorf("Hive complex result column %q could not be bound to exact source metadata", column.Name)
		}
		if err := hivesql.ValidateReadableType(full[found].Type); err != nil {
			return nil, err
		}
		enriched[i].Type = full[found].Type
		enriched[i].Nullable = full[found].Nullable
		enriched[i].Key = full[found].Key
		enriched[i].Default = full[found].Default
		enriched[i].HasDefault = full[found].HasDefault
		enriched[i].Comment = full[found].Comment
		enriched[i].Extra = full[found].Extra
	}
	return enriched, nil
}
func hiveSourceLabelMatches(label, column string, source hivesql.SourceProjection) bool {
	if strings.EqualFold(label, column) {
		return true
	}
	for _, qualifier := range []string{source.Table, source.Alias, source.Database + "." + source.Table} {
		if qualifier != "" && strings.EqualFold(label, qualifier+"."+column) {
			return true
		}
	}
	return false
}
func hiveProjectedResultTypes(source hivesql.SourceProjection, columns []connection.ColumnDefinition) ([]connection.ColumnDefinition, error) {
	if !source.Wildcard && len(columns) != len(source.Columns) {
		return nil, fmt.Errorf("Hive derived source projection width changed")
	}
	result := append([]connection.ColumnDefinition(nil), columns...)
	for i, column := range result {
		if !hiveBareComplexType(column.Type) {
			continue
		}
		typ := ""
		if !source.Wildcard {
			typ = source.Columns[i].Type
		} else {
			for _, extra := range source.Columns {
				label := extra.Alias
				if label == "" {
					label = extra.Name
				}
				if label != "" && hiveSourceLabelMatches(column.Name, label, source) {
					typ = extra.Type
					break
				}
			}
		}
		if typ != "" {
			if err := hivesql.ValidateReadableType(typ); err != nil {
				return nil, err
			}
			result[i].Type = typ
		}
	}
	return result, nil
}
