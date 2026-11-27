package app

import (
	"errors"
	"strings"

	"GoNavi-Wails/internal/dataexport"
)

const (
	maxXLSXRowsPerSheet     = 1048575
	defaultXLSXRowsPerSheet = maxXLSXRowsPerSheet
)

type ExportFileOptions struct {
	LosslessHive                   bool                              `json:"losslessHive,omitempty"`
	PluginExporter                 *dataexport.PluginExportSelection `json:"pluginExporter,omitempty"`
	DataGzipBase64                 string                            `json:"dataGzipBase64,omitempty"` // Frontend-compressed query rows; decoded only by ExportDataWithOptions.
	Format                         string                            `json:"format"`
	CSVEncoding                    string                            `json:"csvEncoding,omitempty"`
	Columns                        []string                          `json:"columns,omitempty"`
	TableColumns                   map[string][]string               `json:"tableColumns,omitempty"`
	ColumnComments                 map[string]string                 `json:"columnComments,omitempty"`
	XLSXMaxRowsPerSheet            int                               `json:"xlsxMaxRowsPerSheet,omitempty"`
	JobID                          string                            `json:"jobId,omitempty"`
	TotalRowsHint                  int64                             `json:"totalRowsHint,omitempty"`
	TotalRowsKnown                 bool                              `json:"totalRowsKnown,omitempty"`
	IncludeDropIfExists            bool                              `json:"includeDropIfExists,omitempty"`
	IncludeDatabaseContext         bool                              `json:"includeDatabaseContext,omitempty"`
	InsertSQLDialect               string                            `json:"insertSQLDialect,omitempty"`
	InsertSQLTargetTable           string                            `json:"insertSQLTargetTable,omitempty"`
	InsertSQLColumnOrder           []string                          `json:"insertSQLColumnOrder,omitempty"`
	InsertSQLPartitionColumns      []string                          `json:"insertSQLPartitionColumns,omitempty"`
	InsertSQLColumnTypes           map[string]string                 `json:"insertSQLColumnTypes,omitempty"`
	InsertSQLTargetColumns         map[string]string                 `json:"insertSQLTargetColumns,omitempty"`
	InsertSQLAllowEmptyTargetTable bool                              `json:"insertSQLAllowEmptyTargetTable,omitempty"`
}

func normalizeExportFileOptions(format string, options ExportFileOptions) ExportFileOptions {
	resolvedFormat := strings.ToLower(strings.TrimSpace(format))
	if explicitFormat := strings.ToLower(strings.TrimSpace(options.Format)); explicitFormat != "" {
		resolvedFormat = explicitFormat
	}
	return ExportFileOptions{
		LosslessHive:                   options.LosslessHive,
		PluginExporter:                 options.PluginExporter,
		DataGzipBase64:                 strings.TrimSpace(options.DataGzipBase64),
		Format:                         resolvedFormat,
		CSVEncoding:                    options.CSVEncoding,
		Columns:                        normalizeExportColumns(options.Columns),
		TableColumns:                   normalizeExportTableColumns(options.TableColumns),
		ColumnComments:                 options.ColumnComments,
		XLSXMaxRowsPerSheet:            normalizeXLSXRowsPerSheet(options.XLSXMaxRowsPerSheet),
		JobID:                          strings.TrimSpace(options.JobID),
		TotalRowsHint:                  normalizeExportTotalRowsHint(options.TotalRowsHint, options.TotalRowsKnown),
		TotalRowsKnown:                 options.TotalRowsKnown,
		IncludeDropIfExists:            options.IncludeDropIfExists,
		IncludeDatabaseContext:         options.IncludeDatabaseContext,
		InsertSQLDialect:               normalizeInsertSQLDialect(options.InsertSQLDialect),
		InsertSQLTargetTable:           strings.TrimSpace(options.InsertSQLTargetTable),
		InsertSQLColumnOrder:           append([]string(nil), options.InsertSQLColumnOrder...),
		InsertSQLPartitionColumns:      append([]string(nil), options.InsertSQLPartitionColumns...),
		InsertSQLColumnTypes:           options.InsertSQLColumnTypes,
		InsertSQLTargetColumns:         options.InsertSQLTargetColumns,
		InsertSQLAllowEmptyTargetTable: options.InsertSQLAllowEmptyTargetTable,
	}
}

func resolveExportColumnHeaders(columns []string, comments map[string]string) []string {
	headers := make([]string, len(columns))
	for index, column := range columns {
		headers[index] = column
		if comment := strings.TrimSpace(comments[column]); comment != "" {
			headers[index] = comment
		}
	}
	return headers
}

// normalizeInsertSQLDialect 把前端传来的连接类型归一为写 INSERT 用的方言：借用方言的描述表类型（TiDB、
// CockroachDB 等）按被借用方言转义字符串、布尔值与标识符。
func normalizeInsertSQLDialect(dialect string) string {
	dialect = strings.ToLower(strings.TrimSpace(dialect))
	if borrowed, ok := registryDDLDialect(dialect); ok {
		return borrowed
	}
	return dialect
}

func normalizeExportColumns(columns []string) []string {
	if columns == nil {
		return nil
	}
	result := make([]string, 0, len(columns))
	seen := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		if strings.TrimSpace(column) == "" {
			continue
		}
		if _, exists := seen[column]; exists {
			continue
		}
		seen[column] = struct{}{}
		result = append(result, column)
	}
	return result
}

func normalizeExportTableColumns(tableColumns map[string][]string) map[string][]string {
	if len(tableColumns) == 0 {
		return nil
	}
	result := make(map[string][]string, len(tableColumns))
	for tableName, columns := range tableColumns {
		tableName = strings.TrimSpace(tableName)
		columns = normalizeExportColumns(columns)
		if tableName == "" || len(columns) == 0 {
			continue
		}
		result[tableName] = columns
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func exportColumnsForTable(tableColumns map[string][]string, tableName string) []string {
	if len(tableColumns) == 0 {
		return nil
	}
	tableName = strings.TrimSpace(tableName)
	if columns, ok := tableColumns[tableName]; ok {
		return columns
	}
	for name, columns := range tableColumns {
		if strings.EqualFold(name, tableName) {
			return columns
		}
	}
	return nil
}

func validateExportColumnsSelection(options ExportFileOptions) error {
	if options.Columns != nil && len(options.Columns) == 0 {
		return errors.New("at least one export column must be selected")
	}
	return nil
}

func normalizeXLSXRowsPerSheet(value int) int {
	if value <= 0 {
		return defaultXLSXRowsPerSheet
	}
	if value > maxXLSXRowsPerSheet {
		return maxXLSXRowsPerSheet
	}
	return value
}

func normalizeExportTotalRowsHint(value int64, known bool) int64 {
	if !known {
		return 0
	}
	if value < 0 {
		return 0
	}
	return value
}
