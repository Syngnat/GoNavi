package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// ImportInferredColumn 是「按文件新建表」向导里的一列。LogicalType 是与方言无关的
// 逻辑类型，由前端按目标方言映射为具体类型；这样推断只做一次，新增方言不需要改后端。
type ImportInferredColumn struct {
	Name         string `json:"name"`
	SourceName   string `json:"sourceName"`
	LogicalType  string `json:"logicalType"`
	DeclaredType string `json:"declaredType,omitempty"`
	Comment      string `json:"comment,omitempty"`
	Nullable     bool   `json:"nullable"`
	MaxLength    int    `json:"maxLength,omitempty"`
	Precision    int    `json:"precision,omitempty"`
	Scale        int    `json:"scale,omitempty"`
}

type ImportTableSchemaInference struct {
	TableName   string                 `json:"tableName"`
	Columns     []ImportInferredColumn `json:"columns"`
	Warnings    []string               `json:"warnings"`
	SampledRows int                    `json:"sampledRows"`
	SampleLimit int                    `json:"sampleLimit"`
}

const importSchemaSampleLimit = 500

var errImportSchemaSampleReached = errors.New("import schema sample limit reached")

var (
	importSchemaIntegerPattern = regexp.MustCompile(`^[+-]?\d+$`)
	importSchemaDecimalPattern = regexp.MustCompile(`^[+-]?(?:\d+\.\d*|\.\d+)$`)
	importSchemaFloatPattern   = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`)
	importSchemaBooleanPattern = regexp.MustCompile(`(?i)^(?:true|false)$`)
	importSchemaUUIDPattern    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

var (
	importSchemaDateLayouts = []string{
		"2006-01-02", "2006/01/02", "2006.01.02", "2006年01月02日",
	}
	importSchemaDateTimeLayouts = []string{
		"2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006/01/02 15:04:05",
		"2006-01-02 15:04", "2006-01-02T15:04", "2006年01月02日 15:04:05",
		"2006-01-02 15:04:05.999999", "2006-01-02T15:04:05.999999",
	}
	importSchemaTimeLayouts = []string{
		"15:04:05", "15:04", "15:04:05.999999",
	}
)

type importColumnSample struct {
	seen             int
	empty            int
	maxLength        int
	integer          int
	numeric          int
	boolean          int
	date             int
	datetime         int
	timeOnly         int
	uuid             int
	jsonValue        int
	maxIntegerDigits int
	maxScale         int
}

func importSchemaSampleText(value interface{}) (string, bool) {
	switch typed := value.(type) {
	case nil:
		return "", false
	case string:
		text := strings.TrimSpace(strings.TrimPrefix(typed, "\ufeff"))
		return text, text != ""
	case []byte:
		text := strings.TrimSpace(string(typed))
		return text, text != ""
	case bool:
		if typed {
			return "true", true
		}
		return "false", true
	case int:
		return strconv.FormatInt(int64(typed), 10), true
	case int8:
		return strconv.FormatInt(int64(typed), 10), true
	case int16:
		return strconv.FormatInt(int64(typed), 10), true
	case int32:
		return strconv.FormatInt(int64(typed), 10), true
	case int64:
		return strconv.FormatInt(typed, 10), true
	case uint:
		return strconv.FormatUint(uint64(typed), 10), true
	case uint8:
		return strconv.FormatUint(uint64(typed), 10), true
	case uint16:
		return strconv.FormatUint(uint64(typed), 10), true
	case uint32:
		return strconv.FormatUint(uint64(typed), 10), true
	case uint64:
		return strconv.FormatUint(typed, 10), true
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 32), true
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64), true
	case json.Number:
		return typed.String(), true
	case time.Time:
		return typed.Format("2006-01-02 15:04:05.999999"), true
	default:
		text := strings.TrimSpace(fmt.Sprintf("%v", typed))
		return text, text != ""
	}
}

func (s *importColumnSample) observeNumber(text string) {
	unsigned := strings.TrimLeft(text, "+-")
	integerDigits := len(unsigned)
	scale := 0
	if dot := strings.IndexByte(unsigned, '.'); dot >= 0 {
		integerDigits = dot
		scale = len(unsigned) - dot - 1
	}
	if integerDigits > s.maxIntegerDigits {
		s.maxIntegerDigits = integerDigits
	}
	if scale > s.maxScale {
		s.maxScale = scale
	}
}

func (s *importColumnSample) add(value interface{}) {
	text, ok := importSchemaSampleText(value)
	if !ok {
		s.empty++
		return
	}
	s.seen++
	if size := utf8.RuneCountInString(text); size > s.maxLength {
		s.maxLength = size
	}
	switch {
	case importSchemaBooleanPattern.MatchString(text):
		s.boolean++
	case importSchemaIntegerPattern.MatchString(text):
		s.integer++
		s.numeric++
		s.observeNumber(text)
	case importSchemaDecimalPattern.MatchString(text):
		s.numeric++
		s.observeNumber(text)
	case importSchemaFloatPattern.MatchString(text):
		s.numeric++
	case importSchemaUUIDPattern.MatchString(text):
		s.uuid++
	case importSchemaMatchesLayouts(text, importSchemaDateTimeLayouts):
		s.datetime++
	case importSchemaMatchesLayouts(text, importSchemaDateLayouts):
		s.date++
	case importSchemaMatchesLayouts(text, importSchemaTimeLayouts):
		s.timeOnly++
	case importSchemaLooksLikeJSON(text):
		s.jsonValue++
	}
}

func importSchemaMatchesLayouts(text string, layouts []string) bool {
	for _, layout := range layouts {
		if _, err := time.Parse(layout, text); err == nil {
			return true
		}
	}
	return false
}

func importSchemaLooksLikeJSON(text string) bool {
	if len(text) < 2 {
		return false
	}
	if text[0] != '{' && text[0] != '[' {
		return false
	}
	return json.Valid([]byte(text))
}

func (s importColumnSample) logicalType() string {
	switch {
	case s.seen == 0:
		return "text"
	case s.integer == s.seen:
		if s.maxIntegerDigits > 18 {
			return "decimal"
		}
		return "integer"
	case s.numeric == s.seen:
		return "decimal"
	case s.boolean == s.seen:
		return "boolean"
	case s.datetime == s.seen:
		return "datetime"
	case s.date == s.seen:
		return "date"
	case s.timeOnly == s.seen:
		return "time"
	case s.uuid == s.seen:
		return "uuid"
	case s.jsonValue == s.seen:
		return "json"
	case s.maxLength > 255:
		return "longtext"
	default:
		return "text"
	}
}

type importInferenceWarning struct {
	Key    string
	Params map[string]any
}

type importSchemaSampleConsumer struct {
	limit   int
	columns []string
	samples []importColumnSample
	rows    int
}

func newImportSchemaSampleConsumer(limit int) *importSchemaSampleConsumer {
	if limit <= 0 {
		limit = importSchemaSampleLimit
	}
	return &importSchemaSampleConsumer{limit: limit}
}

func (c *importSchemaSampleConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	c.samples = make([]importColumnSample, len(columns))
	return nil
}

func (c *importSchemaSampleConsumer) ConsumeRow(row map[string]interface{}) error {
	for index, column := range c.columns {
		c.samples[index].add(row[column])
	}
	c.rows++
	if c.rows >= c.limit {
		return errImportSchemaSampleReached
	}
	return nil
}

type importTableSchemaInference struct {
	TableName   string
	Columns     []ImportInferredColumn
	Warnings    []importInferenceWarning
	SampledRows int
	SampleLimit int
}

func inferImportTableSchema(ctx context.Context, filePath string, options ImportFileOptions, identifierLimit int) (importTableSchemaInference, error) {
	if err := validateImportFileOptions(options); err != nil {
		return importTableSchemaInference{}, err
	}
	metadata, err := readImportHeaderMetadata(ctx, filePath, options)
	if err != nil {
		return importTableSchemaInference{}, err
	}
	sampleOptions := options
	if len(metadata.Header) > 0 {
		sampleOptions.HeaderRow = importHeaderMetadataMaxRow(options)
		sampleOptions.HeaderOverride = cloneImportColumns(metadata.Header)
	}
	consumer := newImportSchemaSampleConsumer(importSchemaSampleLimit)
	err = streamImportFileWithOptionsContext(ctx, filePath, consumer, sampleOptions)
	if err != nil && !errors.Is(err, errImportSchemaSampleReached) {
		return importTableSchemaInference{}, err
	}
	rawColumns := consumer.columns
	if len(metadata.Header) > 0 {
		rawColumns = metadata.Header
	}

	type parsedHeaderCell struct {
		name         string
		declaredType string
		comment      string
	}
	parsed := make([]parsedHeaderCell, len(rawColumns))
	parsedNames := make([]string, len(rawColumns))
	for index, raw := range rawColumns {
		name, declaredType, comment := parseImportHeaderCell(raw)
		if index < len(metadata.Types) {
			if value := strings.TrimSpace(metadata.Types[index]); isImportHeaderDeclaredType(value) {
				declaredType = value
			}
		}
		if index < len(metadata.Comments) {
			if value := strings.TrimSpace(metadata.Comments[index]); value != "" {
				comment = value
			}
		}
		parsed[index] = parsedHeaderCell{name: name, declaredType: declaredType, comment: comment}
		parsedNames[index] = name
	}
	names, warnings := normalizeImportSchemaColumnNames(parsedNames, identifierLimit)
	columns := make([]ImportInferredColumn, 0, len(names))
	for index, name := range names {
		sample := consumer.samples[index]
		cell := parsed[index]
		if cell.name != strings.TrimSpace(rawColumns[index]) && name == cell.name {
			warnings = append(warnings, importInferenceWarning{
				Key:    "file.backend.warning.import_header_parsed",
				Params: map[string]any{"source": strings.TrimSpace(rawColumns[index]), "name": name},
			})
		}
		column := ImportInferredColumn{
			Name:         name,
			SourceName:   rawColumns[index],
			LogicalType:  sample.logicalType(),
			DeclaredType: cell.declaredType,
			Comment:      cell.comment,
			Nullable:     true,
			MaxLength:    sample.maxLength,
		}
		if column.LogicalType == "decimal" {
			column.Precision = sample.maxIntegerDigits + sample.maxScale
			column.Scale = sample.maxScale
		}
		columns = append(columns, column)
	}
	return importTableSchemaInference{
		TableName:   suggestImportTableName(filePath, identifierLimit),
		Columns:     columns,
		Warnings:    warnings,
		SampledRows: consumer.rows,
		SampleLimit: consumer.limit,
	}, nil
}

func normalizeImportSchemaColumnNames(raw []string, limit int) ([]string, []importInferenceWarning) {
	if limit <= 0 {
		limit = 64
	}
	names := make([]string, len(raw))
	warnings := make([]importInferenceWarning, 0)
	used := make(map[string]int, len(raw))
	for index, source := range raw {
		base := strings.TrimSpace(strings.TrimPrefix(source, "\ufeff"))
		if base == "" {
			base = fmt.Sprintf("column_%d", index+1)
		}
		base = truncateImportIdentifier(base, limit)
		name := base
		for suffix := 2; ; suffix++ {
			key := strings.ToLower(name)
			if _, exists := used[key]; !exists {
				used[key] = index
				break
			}
			suffixText := fmt.Sprintf("_%d", suffix)
			name = truncateImportIdentifier(base, limit-utf8.RuneCountInString(suffixText)) + suffixText
		}
		if name != strings.TrimSpace(source) {
			warnings = append(warnings, importInferenceWarning{
				Key:    "file.backend.warning.import_column_renamed",
				Params: map[string]any{"source": strings.TrimSpace(source), "name": name},
			})
		}
		names[index] = name
	}
	return names, warnings
}

func truncateImportIdentifier(value string, limit int) string {
	if limit <= 0 {
		limit = 1
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func suggestImportTableName(filePath string, limit int) string {
	base := filepath.Base(strings.TrimSpace(filePath))
	base = strings.TrimSuffix(base, filepath.Ext(base))
	var builder strings.Builder
	lastUnderscore := false
	for _, char := range base {
		switch {
		case unicode.IsLetter(char), unicode.IsDigit(char):
			builder.WriteRune(char)
			lastUnderscore = false
		default:
			if !lastUnderscore {
				builder.WriteRune('_')
				lastUnderscore = true
			}
		}
	}
	name := strings.Trim(builder.String(), "_")
	if name == "" {
		name = "imported_table"
	}
	if first, _ := utf8.DecodeRuneInString(name); unicode.IsDigit(first) {
		name = "t_" + name
	}
	return truncateImportIdentifier(name, limit)
}

func importIdentifierLimitRunes(dbType string) int {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb",
		"cockroachdb", "kwdb", "timescaledb", "gbase8c", "greptimedb", "firebird", "gbase8s":
		return 63
	case "oracle", "dameng", "yashandb", "sqlserver", "hive":
		return 128
	case "sqlite", "clickhouse":
		return 255
	case "questdb":
		return 127
	case "tdengine":
		return 64
	default:
		return 64
	}
}
