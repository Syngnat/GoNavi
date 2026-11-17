package app

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"
)

// importHeaderMetadata 描述表头之外的元数据行：类型行与注释行都按列顺序对齐表头。
// 这两行只用于推断/建表，不会作为数据导入。
type importHeaderMetadata struct {
	Header   []string
	Types    []string
	Comments []string
}

const maxImportHeaderMetadataRow = maxImportHeaderRow

func validateImportHeaderMetadataRows(options ImportFileOptions) error {
	if options.TypeRow < 0 || options.TypeRow > maxImportHeaderMetadataRow {
		return fmt.Errorf("import typeRow must be between 0 and %d", maxImportHeaderMetadataRow)
	}
	if options.CommentRow < 0 || options.CommentRow > maxImportHeaderMetadataRow {
		return fmt.Errorf("import commentRow must be between 0 and %d", maxImportHeaderMetadataRow)
	}
	if options.TypeRow > 0 && options.TypeRow == options.CommentRow {
		return fmt.Errorf("import typeRow and commentRow must be different")
	}
	headerRow, err := resolveImportHeaderRow(options.HeaderRow)
	if err != nil {
		return err
	}
	// HeaderOverride 存在时表示元数据行已经被读取并折算成「跳过前 N 行」，
	// 此时 HeaderRow 已经推进到元数据行之后，不能再按原始表头行做比较。
	if len(options.HeaderOverride) == 0 {
		if options.TypeRow > 0 && options.TypeRow <= headerRow {
			return fmt.Errorf("import typeRow must be after headerRow %d", headerRow)
		}
		if options.CommentRow > 0 && options.CommentRow <= headerRow {
			return fmt.Errorf("import commentRow must be after headerRow %d", headerRow)
		}
	}
	return nil
}

func importHeaderMetadataMaxRow(options ImportFileOptions) int {
	headerRow, err := resolveImportHeaderRow(options.HeaderRow)
	if err != nil {
		return 0
	}
	return maxInt(headerRow, maxInt(options.TypeRow, options.CommentRow))
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func importHeaderRowValues(row map[string]interface{}, header []string) []string {
	values := make([]string, len(header))
	for index, name := range header {
		values[index] = importHeaderCellText(row[name])
	}
	return values
}

func importHeaderCellText(value interface{}) string {
	text, ok := importSchemaSampleText(value)
	if !ok {
		return ""
	}
	return text
}

// readImportHeaderMetadata 读取表头、类型行与注释行。TypeRow/CommentRow 为 0 时不做任何事。
// 内部复用流式预览，但会先清空这三项选项，避免递归。
func readImportHeaderMetadata(ctx context.Context, filePath string, options ImportFileOptions) (importHeaderMetadata, error) {
	if options.TypeRow <= 0 && options.CommentRow <= 0 {
		return importHeaderMetadata{}, nil
	}
	if strings.HasSuffix(strings.ToLower(strings.TrimSpace(filePath)), ".json") {
		return importHeaderMetadata{}, fmt.Errorf("JSON 导入不支持类型行/注释行，请改用 CSV 或 Excel")
	}
	if err := validateImportHeaderMetadataRows(options); err != nil {
		return importHeaderMetadata{}, err
	}
	headerRow, err := resolveImportHeaderRow(options.HeaderRow)
	if err != nil {
		return importHeaderMetadata{}, err
	}
	maxRow := importHeaderMetadataMaxRow(options)
	previewOptions := options
	previewOptions.TypeRow = 0
	previewOptions.CommentRow = 0
	previewOptions.HeaderOverride = nil
	preview, err := buildImportPreviewWithOptionsContext(ctx, filePath, maxRow-headerRow, previewOptions)
	if err != nil {
		return importHeaderMetadata{}, err
	}
	header := cloneImportColumns(preview.Columns)
	if len(header) == 0 {
		return importHeaderMetadata{}, fmt.Errorf("导入文件缺少表头")
	}
	readRow := func(rowNumber int) ([]string, error) {
		if rowNumber <= headerRow || rowNumber > maxRow {
			return make([]string, len(header)), nil
		}
		index := rowNumber - headerRow - 1
		if index < 0 || index >= len(preview.PreviewRows) {
			return nil, fmt.Errorf("导入文件缺少第 %d 行（类型行/注释行）", rowNumber)
		}
		return importHeaderRowValues(preview.PreviewRows[index], header), nil
	}
	metadata := importHeaderMetadata{Header: header}
	if options.TypeRow > 0 {
		if metadata.Types, err = readRow(options.TypeRow); err != nil {
			return importHeaderMetadata{}, err
		}
	}
	if options.CommentRow > 0 {
		if metadata.Comments, err = readRow(options.CommentRow); err != nil {
			return importHeaderMetadata{}, err
		}
	}
	return metadata, nil
}

// normalizeImportFileHeaderOptions 把类型/注释行改成解析器可跳过的形式：
// HeaderRow 推进到最后一个元数据行，列名仍用原始表头，数据从下一行开始。
func normalizeImportFileHeaderOptions(ctx context.Context, filePath string, options ImportFileOptions) (ImportFileOptions, error) {
	if options.TypeRow <= 0 && options.CommentRow <= 0 {
		return options, nil
	}
	metadata, err := readImportHeaderMetadata(ctx, filePath, options)
	if err != nil {
		return options, err
	}
	options.HeaderRow = importHeaderMetadataMaxRow(options)
	options.HeaderOverride = cloneImportColumns(metadata.Header)
	return options, nil
}

func isImportHeaderDeclaredType(raw string) bool {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return false
	}
	// 去掉类型里的空格，统一 full-width 括号，便于白名单判断。
	value = strings.NewReplacer("（", "(", "）", ")", " ", "").Replace(value)
	switch value {
	case "int", "int4", "int8", "integer", "tinyint", "tinyint(1)", "smallint", "mediumint", "bigint",
		"tinyint(1)unsigned", "intunsigned", "bigintunsigned",
		"bool", "boolean", "bit", "bit(1)",
		"float", "double", "doubleprecision", "real", "decimal", "numeric", "number",
		"date", "time", "datetime", "timestamp", "timestamptz", "timestampwithtimezone",
		"json", "jsonb", "uuid", "text", "longtext", "mediumtext", "tinytext", "clob", "nclob",
		"blob", "bytea", "binary", "varbinary", "serial", "bigserial", "smallserial",
		"string", "varchar2", "nvarchar2", "nvarchar":
		return true
	}
	if strings.HasPrefix(value, "varchar(") || strings.HasPrefix(value, "char(") ||
		strings.HasPrefix(value, "nvarchar(") || strings.HasPrefix(value, "nchar(") ||
		strings.HasPrefix(value, "decimal(") || strings.HasPrefix(value, "numeric(") ||
		strings.HasPrefix(value, "number(") || strings.HasPrefix(value, "timestamp(") ||
		strings.HasPrefix(value, "datetime(") || strings.HasPrefix(value, "time(") ||
		strings.HasPrefix(value, "varbinary(") || strings.HasPrefix(value, "binary(") ||
		strings.HasPrefix(value, "char(") {
		return true
	}
	return false
}

// splitImportHeaderComments 按逗号/分号拆分类型与注释，但忽略括号内的分隔符
// （例如 decimal(10,2) 里的逗号）。
func splitImportHeaderComments(raw string) []string {
	parts := make([]string, 0, 2)
	depth := 0
	current := strings.Builder{}
	for _, char := range raw {
		switch char {
		case '(', '（':
			depth++
			current.WriteRune(char)
		case ')', '）':
			if depth > 0 {
				depth--
			}
			current.WriteRune(char)
		case ',', '，', ';', '；':
			if depth == 0 {
				parts = append(parts, strings.TrimSpace(current.String()))
				current.Reset()
				continue
			}
			current.WriteRune(char)
		default:
			current.WriteRune(char)
		}
	}
	parts = append(parts, strings.TrimSpace(current.String()))
	return parts
}

func splitImportHeaderParenthesized(raw string) (prefix string, inner string, ok bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", "", false
	}
	last, lastSize := utf8.DecodeLastRuneInString(text)
	if last != ')' && last != '）' {
		return "", "", false
	}
	closeStart := len(text) - lastSize
	depth := 0
	for index := len(text); index > 0; {
		r, size := utf8.DecodeLastRuneInString(text[:index])
		index -= size
		switch r {
		case ')', '）':
			depth++
		case '(', '（':
			depth--
			if depth == 0 {
				prefix = strings.TrimSpace(text[:index])
				inner = strings.TrimSpace(text[index+size : closeStart])
				return prefix, inner, prefix != ""
			}
		}
	}
	return "", "", false
}

func isImportHeaderNumericOnly(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	for _, char := range text {
		if (char < '0' || char > '9') && (char < '０' || char > '９') {
			return false
		}
	}
	return true
}

// parseImportHeaderCell 解析单元格里的「列名 + 类型 + 注释」：
//
//	姓名 varchar(50) 客户姓名      -> 姓名 / varchar(50) / 客户姓名
//	姓名（varchar(50)，客户姓名） -> 姓名 / varchar(50) / 客户姓名
//	金额(元)                      -> 金额 / "" / 元
//
// 解析不到类型时保持原列名，避免误伤正常表头。
func parseImportHeaderCell(raw string) (name string, declaredType string, comment string) {
	name = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "\ufeff"))
	if name == "" {
		return "", "", ""
	}
	fields := strings.Fields(name)
	for index := len(fields) - 1; index >= 1; index-- {
		candidate := fields[index]
		if !isImportHeaderDeclaredType(candidate) {
			continue
		}
		prefix := strings.TrimSpace(strings.Join(fields[:index], " "))
		if prefix == "" {
			return name, "", ""
		}
		return prefix, candidate, strings.TrimSpace(strings.Join(fields[index+1:], " "))
	}
	if prefix, inner, ok := splitImportHeaderParenthesized(name); ok {
		parts := splitImportHeaderComments(inner)
		if len(parts) > 0 && isImportHeaderDeclaredType(parts[0]) {
			return prefix, parts[0], strings.Join(parts[1:], "，")
		}
		// 纯数字括号更像列名的一部分（如「订单(2024)」），不当作注释剥离。
		if isImportHeaderNumericOnly(inner) {
			return name, "", ""
		}
		return prefix, "", inner
	}
	return name, "", ""
}
