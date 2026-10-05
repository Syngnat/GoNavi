package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
)

func buildImportPreview(filePath string, previewLimit int) (importPreviewData, error) {
	return buildImportPreviewWithOptions(filePath, previewLimit, ImportFileOptions{})
}

func buildImportPreviewWithOptions(filePath string, previewLimit int, options ImportFileOptions) (importPreviewData, error) {
	return buildImportPreviewWithOptionsContext(context.Background(), filePath, previewLimit, options)
}

func buildImportPreviewWithOptionsContext(ctx context.Context, filePath string, previewLimit int, options ImportFileOptions) (importPreviewData, error) {
	collector := newImportPreviewCollector(previewLimit)
	if err := streamImportFileWithOptionsContext(ctx, filePath, collector, options); err != nil && !errors.Is(err, errImportPreviewLimitReached) {
		return importPreviewData{}, err
	} else if err == nil {
		collectorResult := collector.Result()
		collectorResult.TotalRowsKnown = true
		return collectorResult, nil
	}
	return collector.Result(), nil
}

func parseImportFile(filePath string) ([]map[string]interface{}, []string, error) {
	collector := &importCollectConsumer{}
	if err := streamImportFile(filePath, collector); err != nil {
		return nil, nil, err
	}
	return collector.rows, collector.columns, nil
}

func streamImportFile(filePath string, consumer importFileConsumer) error {
	return streamImportFileWithOptions(filePath, consumer, ImportFileOptions{})
}

func streamImportFileWithOptions(filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	return streamImportFileWithOptionsContext(context.Background(), filePath, consumer, options)
}

func streamImportFileWithOptionsContext(ctx context.Context, filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	if consumer == nil {
		return fmt.Errorf("import file consumer is required")
	}
	if err := validateImportFileOptions(options); err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	consumer = &contextImportFileConsumer{ctx: ctx, delegate: consumer}
	lower := strings.ToLower(filePath)
	switch {
	case strings.HasSuffix(lower, ".json"):
		return streamJSONImportFileWithOptions(filePath, consumer, options)
	case strings.HasSuffix(lower, ".csv"):
		return streamCSVImportFileWithOptions(filePath, consumer, options)
	case strings.HasSuffix(lower, ".xlsx"):
		return streamXLSXImportFileWithOptions(filePath, consumer, options)
	case strings.HasSuffix(lower, ".xls"):
		return fmt.Errorf("legacy binary .xls workbooks are not supported; convert the file to .xlsx or CSV")
	default:
		return fmt.Errorf("Unsupported file format")
	}
}

const (
	importConflictPolicyStop           = "stop"
	importConflictPolicySkipDuplicates = "skip_duplicates"
	importConflictPolicyUpsert         = "upsert"
	maxImportNullTokenRunes            = 64
	maxImportSheetNameRunes            = 255
)

func normalizeImportConflictPolicy(value string) string {
	policy := strings.ToLower(strings.TrimSpace(value))
	if policy == "" {
		return importConflictPolicyStop
	}
	return policy
}

func isMySQLConflictDialect(dbType string) bool {
	switch resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) {
	case "mysql", "mariadb", "oceanbase":
		return true
	default:
		return false
	}
}

func isPostgresConflictDialect(dbType string) bool {
	return resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) == "postgres"
}

func validateImportConflictPolicyForDB(dbType string, options ImportFileOptions) error {
	policy := normalizeImportConflictPolicy(options.ConflictPolicy)
	if policy == importConflictPolicyStop {
		return nil
	}
	if !isMySQLConflictDialect(dbType) && !isPostgresConflictDialect(dbType) && resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) != "sqlite" {
		return fmt.Errorf("import conflict policy %q is not supported for database type %q", policy, dbType)
	}
	if policy == importConflictPolicyUpsert && isMySQLConflictDialect(dbType) {
		return fmt.Errorf("import upsert cannot safely target selected conflict keys for database type %q", dbType)
	}
	if policy == importConflictPolicyUpsert && len(options.ConflictKeyColumns) == 0 {
		return fmt.Errorf("import upsert requires at least one conflict key column")
	}
	return nil
}

func validateImportFileOptions(options ImportFileOptions) error {
	if _, err := normalizeImportTextEncoding(options.Encoding); err != nil {
		return fmt.Errorf("invalid import encoding: %w", err)
	}
	if _, _, err := resolveImportDelimiter(options.Delimiter); err != nil {
		return fmt.Errorf("invalid import delimiter: %w", err)
	}
	if _, err := resolveImportHeaderRow(options.HeaderRow); err != nil {
		return err
	}
	switch normalizeImportConflictPolicy(options.ConflictPolicy) {
	case importConflictPolicyStop, importConflictPolicySkipDuplicates, importConflictPolicyUpsert:
	default:
		return fmt.Errorf("unsupported import conflictPolicy %q", options.ConflictPolicy)
	}
	if options.NullToken != nil {
		if !utf8.ValidString(*options.NullToken) {
			return fmt.Errorf("import nullToken must be valid UTF-8")
		}
		if utf8.RuneCountInString(*options.NullToken) > maxImportNullTokenRunes {
			return fmt.Errorf("import nullToken exceeds %d-character limit", maxImportNullTokenRunes)
		}
	}
	if !utf8.ValidString(options.SheetName) {
		return fmt.Errorf("import sheetName must be valid UTF-8")
	}
	if utf8.RuneCountInString(options.SheetName) > maxImportSheetNameRunes {
		return fmt.Errorf("import sheetName exceeds %d-character limit", maxImportSheetNameRunes)
	}
	seenConflictKeys := make(map[string]struct{}, len(options.ConflictKeyColumns))
	for _, column := range options.ConflictKeyColumns {
		if strings.TrimSpace(column) == "" {
			return fmt.Errorf("import conflictKeyColumns must not contain empty names")
		}
		normalizedColumn := normalizeColumnName(column)
		if _, duplicate := seenConflictKeys[normalizedColumn]; duplicate {
			return fmt.Errorf("import conflictKeyColumns contains duplicate column %q", column)
		}
		seenConflictKeys[normalizedColumn] = struct{}{}
	}
	return nil
}

func streamJSONImportFile(filePath string, consumer importFileConsumer) error {
	return streamJSONImportFileWithOptions(filePath, consumer, ImportFileOptions{})
}

func streamJSONImportFileWithOptions(filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	source, err := openImportTextSource(filePath, options.Encoding)
	if err != nil {
		return err
	}
	defer source.Close()

	decoder := newImportJSONDecoderWithLimits(source, importLexicalLimits{})
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("JSON Parse Error: %w", err)
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '[' {
		return fmt.Errorf("JSON Parse Error: root array expected")
	}

	var columns []string
	var columnSet map[string]struct{}
	rowNumber := 0
	for decoder.More() {
		rowNumber++
		var raw map[string]interface{}
		if err := decoder.Decode(&raw); err != nil {
			return fmt.Errorf("JSON Parse Error: %w", err)
		}
		if _, err := validateImportMapRowBytes("JSON", rowNumber, raw); err != nil {
			return err
		}
		if columns == nil {
			columns = importJSONColumns(raw)
			columnSet = make(map[string]struct{}, len(columns))
			for _, column := range columns {
				columnSet[column] = struct{}{}
			}
			if err := consumer.SetColumns(columns); err != nil {
				return err
			}
		} else {
			unknown := make([]string, 0)
			for key := range raw {
				if _, ok := columnSet[key]; !ok {
					unknown = append(unknown, key)
				}
			}
			if len(unknown) > 0 {
				sort.Strings(unknown)
				return fmt.Errorf("JSON Structure Drift at row %d: unknown fields %q", rowNumber, unknown)
			}
		}
		reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())
		if err := consumer.ConsumeRow(normalizeImportMapRowWithOptions(columns, raw, options)); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("JSON Parse Error: %w", err)
	}
	closingDelim, ok := closing.(json.Delim)
	if !ok || closingDelim != ']' {
		return fmt.Errorf("JSON Parse Error: root array is not closed")
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); err == nil {
		return fmt.Errorf("JSON Parse Error: trailing content after root array")
	} else if !errors.Is(err, io.EOF) {
		return fmt.Errorf("JSON Parse Error: trailing content after root array: %w", err)
	}
	reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())
	return nil
}

func streamCSVImportFile(filePath string, consumer importFileConsumer) error {
	return streamCSVImportFileWithOptions(filePath, consumer, ImportFileOptions{})
}

func streamCSVImportFileWithOptions(filePath string, consumer importFileConsumer, options ImportFileOptions) error {
	source, err := openImportTextSource(filePath, options.Encoding)
	if err != nil {
		return err
	}
	defer source.Close()

	reader, err := newImportCSVReader(source, options.Delimiter)
	if err != nil {
		return err
	}
	reader.ReuseRecord = true
	reader.FieldsPerRecord = -1

	headerRow, err := resolveImportHeaderRow(options.HeaderRow)
	if err != nil {
		return err
	}
	var header []string
	for sourceRow := 1; sourceRow <= headerRow; sourceRow++ {
		record, err := reader.Read()
		if err != nil {
			if err == io.EOF {
				return fmt.Errorf("CSV header row %d is missing", headerRow)
			}
			return fmt.Errorf("CSV Parse Error: %w", err)
		}
		if err := validateImportStringCells("CSV", sourceRow, record); err != nil {
			return err
		}
		if sourceRow == headerRow {
			header = cloneImportColumns(record)
		}
	}
	if len(header) > 0 {
		header[0] = strings.TrimPrefix(header[0], "\uFEFF")
	}
	columns := cloneImportColumns(header)
	if !hasImportUsableColumns(columns) {
		return fmt.Errorf("CSV empty or missing header")
	}
	if err := validateImportUniqueColumns("CSV", columns); err != nil {
		return err
	}
	if err := consumer.SetColumns(columns); err != nil {
		return err
	}
	reader.FieldsPerRecord = len(columns)
	reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())

	rowNumber := headerRow
	for {
		record, err := reader.Read()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("CSV Parse Error: %w", err)
		}
		rowNumber++
		if err := validateImportStringCells("CSV", rowNumber, record); err != nil {
			return err
		}
		reportImportSourceProgress(consumer, source.RawBytesRead(), source.TotalBytes())
		if err := consumer.ConsumeRow(buildImportRowFromValuesWithOptions(columns, record, options)); err != nil {
			return err
		}
	}
}

const maxImportHeaderRow = 1_000_000

func resolveImportHeaderRow(value int) (int, error) {
	if value == 0 {
		return 1, nil
	}
	if value < 1 || value > maxImportHeaderRow {
		return 0, fmt.Errorf("import headerRow must be between 1 and %d", maxImportHeaderRow)
	}
	return value, nil
}
