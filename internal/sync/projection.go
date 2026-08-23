package sync

import (
	"GoNavi-Wails/internal/connection"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type ProjectionErrorKind string

const (
	ProjectionErrorKindCompile         ProjectionErrorKind = "compile"
	ProjectionErrorKindSourceMissing   ProjectionErrorKind = "source_missing"
	ProjectionErrorKindSourceAmbiguous ProjectionErrorKind = "source_ambiguous"
	ProjectionErrorKindDefault         ProjectionErrorKind = "default"
	ProjectionErrorKindTransform       ProjectionErrorKind = "transform"
)

// ProjectionError intentionally excludes raw row values from Error() so a
// conversion failure cannot leak credentials or business data into sync logs.
type ProjectionError struct {
	Kind         ProjectionErrorKind
	MappingID    string
	SourceColumn string
	TargetColumn string
	Transform    string
	Cause        error
}

func (e *ProjectionError) Error() string {
	if e == nil {
		return "字段投影失败"
	}
	parts := []string{"字段投影失败"}
	if e.MappingID != "" {
		parts = append(parts, "映射="+e.MappingID)
	}
	if e.SourceColumn != "" {
		parts = append(parts, "源字段="+e.SourceColumn)
	}
	if e.TargetColumn != "" {
		parts = append(parts, "目标字段="+e.TargetColumn)
	}
	if e.Transform != "" {
		parts = append(parts, "转换="+e.Transform)
	}
	if e.Cause != nil {
		reason := e.Cause.Error()
		if e.Kind == ProjectionErrorKindTransform || e.Kind == ProjectionErrorKindDefault {
			reason = "输入值不符合投影规则"
		}
		parts = append(parts, "原因="+reason)
	}
	return strings.Join(parts, "；")
}

func (e *ProjectionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

type compiledProjectionColumn struct {
	source       string
	target       string
	defaultValue interface{}
	hasDefault   bool
	defaultWhen  map[string]struct{}
	transforms   []SyncValueTransform
}

// CompiledProjection is immutable after CompileProjection returns and is safe
// to reuse across rows.
type CompiledProjection struct {
	mappingID        string
	identity         bool
	columns          []compiledProjectionColumn
	sourceTargets    map[string]string
	ambiguousSources map[string]struct{}
}

func CompileProjection(mapping SyncObjectMapping) (*CompiledProjection, error) {
	projection := &CompiledProjection{
		mappingID:        strings.TrimSpace(mapping.ID),
		identity:         len(mapping.Columns) == 0,
		sourceTargets:    make(map[string]string),
		ambiguousSources: make(map[string]struct{}),
	}
	if projection.identity {
		return projection, nil
	}

	usedTargets := make(map[string]string, len(mapping.Columns))
	for _, raw := range mapping.Columns {
		if raw.Drop {
			continue
		}
		source := strings.TrimSpace(raw.Source)
		target := strings.TrimSpace(raw.Target)
		if target == "" {
			return nil, compileProjectionError(projection.mappingID, source, target, "", errors.New("目标字段不能为空"))
		}
		if source == "" && raw.Default == nil {
			return nil, compileProjectionError(projection.mappingID, source, target, "", errors.New("生成字段必须提供默认值"))
		}
		targetKey := strings.ToLower(target)
		if previous, exists := usedTargets[targetKey]; exists {
			return nil, compileProjectionError(projection.mappingID, source, target, "", fmt.Errorf("目标字段被源字段 %s 和 %s 重复使用", previous, source))
		}
		usedTargets[targetKey] = source

		compiled := compiledProjectionColumn{
			source:      source,
			target:      target,
			transforms:  cloneProjectionTransforms(raw.Transforms),
			defaultWhen: make(map[string]struct{}),
		}
		if raw.Default != nil {
			value, err := compileProjectionDefault(*raw.Default)
			if err != nil {
				return nil, &ProjectionError{Kind: ProjectionErrorKindDefault, MappingID: projection.mappingID, SourceColumn: source, TargetColumn: target, Cause: err}
			}
			compiled.defaultValue = value
			compiled.hasDefault = true
			when := raw.Default.When
			if len(when) == 0 {
				when = []string{"missing", "null"}
			}
			for _, condition := range when {
				condition = strings.ToLower(strings.TrimSpace(condition))
				switch condition {
				case "missing", "null", "empty":
					compiled.defaultWhen[condition] = struct{}{}
				default:
					return nil, &ProjectionError{Kind: ProjectionErrorKindDefault, MappingID: projection.mappingID, SourceColumn: source, TargetColumn: target, Cause: fmt.Errorf("不支持的默认值条件 %q", condition)}
				}
			}
		}
		for _, transform := range compiled.transforms {
			if err := validateProjectionTransform(transform); err != nil {
				return nil, compileProjectionError(projection.mappingID, source, target, transform.Type, err)
			}
		}
		projection.columns = append(projection.columns, compiled)
		if source != "" {
			sourceKey := strings.ToLower(source)
			if previous, exists := projection.sourceTargets[sourceKey]; exists && !strings.EqualFold(previous, target) {
				delete(projection.sourceTargets, sourceKey)
				projection.ambiguousSources[sourceKey] = struct{}{}
			} else if _, ambiguous := projection.ambiguousSources[sourceKey]; !ambiguous {
				projection.sourceTargets[sourceKey] = target
			}
		}
	}
	if len(projection.columns) == 0 {
		return nil, compileProjectionError(projection.mappingID, "", "", "", errors.New("字段映射至少需要保留一个目标字段"))
	}
	return projection, nil
}

func compileProjectionError(mappingID, source, target, transform string, cause error) *ProjectionError {
	return &ProjectionError{
		Kind:         ProjectionErrorKindCompile,
		MappingID:    mappingID,
		SourceColumn: source,
		TargetColumn: target,
		Transform:    strings.ToLower(strings.TrimSpace(transform)),
		Cause:        cause,
	}
}

func cloneProjectionTransforms(input []SyncValueTransform) []SyncValueTransform {
	output := make([]SyncValueTransform, len(input))
	for index, transform := range input {
		output[index] = SyncValueTransform{Type: transform.Type}
		if len(transform.Args) > 0 {
			output[index].Args = make(map[string]string, len(transform.Args))
			for key, value := range transform.Args {
				output[index].Args[key] = value
			}
		}
	}
	return output
}

func (p *CompiledProjection) Project(row map[string]interface{}) (map[string]interface{}, error) {
	if p == nil {
		return nil, &ProjectionError{Kind: ProjectionErrorKindCompile, Cause: errors.New("字段投影尚未编译")}
	}
	if p.identity {
		return cloneProjectionRow(row), nil
	}
	output := make(map[string]interface{}, len(p.columns))
	for _, column := range p.columns {
		value, exists, ambiguous := lookupProjectionSourceValue(row, column.source)
		if ambiguous {
			return nil, &ProjectionError{Kind: ProjectionErrorKindSourceAmbiguous, MappingID: p.mappingID, SourceColumn: column.source, TargetColumn: column.target, Cause: errors.New("源行包含多个大小写不一致的同名字段")}
		}
		condition := ""
		switch {
		case column.source == "":
			condition = "missing"
		case !exists:
			condition = "missing"
		case value == nil:
			condition = "null"
		case projectionValueIsEmpty(value):
			condition = "empty"
		}
		if condition != "" && column.hasDefault {
			if _, useDefault := column.defaultWhen[condition]; useDefault || column.source == "" {
				value = cloneProjectionValue(column.defaultValue)
				exists = true
			}
		}
		if !exists {
			return nil, &ProjectionError{Kind: ProjectionErrorKindSourceMissing, MappingID: p.mappingID, SourceColumn: column.source, TargetColumn: column.target, Cause: errors.New("源字段不存在且未配置 missing 默认值")}
		}
		for _, transform := range column.transforms {
			transformed, err := applyProjectionTransform(value, transform)
			if err != nil {
				return nil, &ProjectionError{Kind: ProjectionErrorKindTransform, MappingID: p.mappingID, SourceColumn: column.source, TargetColumn: column.target, Transform: strings.ToLower(strings.TrimSpace(transform.Type)), Cause: err}
			}
			value = transformed
		}
		output[column.target] = value
	}
	return output, nil
}

func (p *CompiledProjection) TargetColumn(source string) (string, bool) {
	if p == nil {
		return "", false
	}
	if p.identity {
		return source, strings.TrimSpace(source) != ""
	}
	sourceKey := strings.ToLower(strings.TrimSpace(source))
	if _, ambiguous := p.ambiguousSources[sourceKey]; ambiguous {
		return "", false
	}
	target, ok := p.sourceTargets[sourceKey]
	return target, ok
}

func (p *CompiledProjection) ValidateSourceColumns(columns []connection.ColumnDefinition) error {
	if p == nil || p.identity {
		return nil
	}
	available := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		available[strings.ToLower(strings.TrimSpace(column.Name))] = struct{}{}
	}
	for _, mapping := range p.columns {
		if mapping.source == "" {
			continue
		}
		if _, exists := available[strings.ToLower(mapping.source)]; !exists {
			_, defaultsMissing := mapping.defaultWhen["missing"]
			if !mapping.hasDefault || !defaultsMissing {
				return &ProjectionError{Kind: ProjectionErrorKindSourceMissing, MappingID: p.mappingID, SourceColumn: mapping.source, TargetColumn: mapping.target, Cause: errors.New("源对象元数据中不存在该字段")}
			}
		}
	}
	return nil
}

func (p *CompiledProjection) MissingTargetColumns(targetColumns, sourceColumns []connection.ColumnDefinition) []string {
	if p == nil {
		return nil
	}
	targets := make(map[string]struct{}, len(targetColumns))
	for _, column := range targetColumns {
		targets[strings.ToLower(strings.TrimSpace(column.Name))] = struct{}{}
	}
	required := make([]string, 0)
	if p.identity {
		for _, column := range sourceColumns {
			name := strings.TrimSpace(column.Name)
			if _, exists := targets[strings.ToLower(name)]; name != "" && !exists {
				required = append(required, name)
			}
		}
		return required
	}
	for _, column := range p.columns {
		if _, exists := targets[strings.ToLower(column.target)]; !exists {
			required = append(required, column.target)
		}
	}
	return required
}

func lookupProjectionSourceValue(row map[string]interface{}, source string) (interface{}, bool, bool) {
	if source == "" {
		return nil, false, false
	}
	if value, exists := row[source]; exists {
		return value, true, false
	}
	var value interface{}
	matches := 0
	for key, candidate := range row {
		if strings.EqualFold(strings.TrimSpace(key), source) {
			value = candidate
			matches++
		}
	}
	return value, matches == 1, matches > 1
}

func projectionValueIsEmpty(value interface{}) bool {
	switch typed := value.(type) {
	case string:
		return typed == ""
	case []byte:
		return len(typed) == 0
	default:
		return false
	}
}

func compileProjectionDefault(value SyncDefaultValue) (interface{}, error) {
	typeName := strings.ToLower(strings.TrimSpace(value.ValueType))
	if typeName == "" {
		typeName = "string"
	}
	if typeName == "null" {
		return nil, nil
	}
	return applyProjectionTransform(value.Value, SyncValueTransform{Type: typeName})
}

func validateProjectionTransform(transform SyncValueTransform) error {
	typeName := strings.ToLower(strings.TrimSpace(transform.Type))
	switch typeName {
	case "trim", "lower", "upper", "string", "int64", "decimal", "decimal-safe", "bool", "date", "timestamp", "json":
	default:
		return fmt.Errorf("不支持的字段转换 %q", transform.Type)
	}
	if timezone := strings.TrimSpace(transform.Args["timezone"]); timezone != "" {
		if _, err := time.LoadLocation(timezone); err != nil {
			return fmt.Errorf("无效时区 %q: %w", timezone, err)
		}
	}
	return nil
}

var projectionDecimalPattern = regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`)

func applyProjectionTransform(value interface{}, transform SyncValueTransform) (interface{}, error) {
	if value == nil {
		return nil, nil
	}
	typeName := strings.ToLower(strings.TrimSpace(transform.Type))
	switch typeName {
	case "trim":
		text, err := projectionStrictString(value)
		if err != nil {
			return nil, err
		}
		return strings.TrimSpace(text), nil
	case "lower":
		text, err := projectionStrictString(value)
		if err != nil {
			return nil, err
		}
		return strings.ToLower(text), nil
	case "upper":
		text, err := projectionStrictString(value)
		if err != nil {
			return nil, err
		}
		return strings.ToUpper(text), nil
	case "string":
		return projectionString(value)
	case "int64":
		return projectionInt64(value)
	case "decimal", "decimal-safe":
		return projectionDecimal(value)
	case "bool":
		return projectionBool(value)
	case "date":
		return projectionTime(value, transform, true)
	case "timestamp":
		return projectionTime(value, transform, false)
	case "json":
		return projectionJSON(value)
	default:
		return nil, fmt.Errorf("不支持的字段转换 %q", transform.Type)
	}
}

func projectionStrictString(value interface{}) (string, error) {
	switch typed := value.(type) {
	case string:
		return typed, nil
	case []byte:
		return string(typed), nil
	case json.Number:
		return typed.String(), nil
	default:
		return "", fmt.Errorf("需要字符串，实际类型为 %T", value)
	}
}

func projectionString(value interface{}) (string, error) {
	switch typed := value.(type) {
	case string:
		return typed, nil
	case []byte:
		return string(typed), nil
	case json.Number:
		return typed.String(), nil
	case time.Time:
		return typed.Format(time.RFC3339Nano), nil
	case map[string]interface{}, []interface{}:
		encoded, err := json.Marshal(typed)
		return string(encoded), err
	default:
		return fmt.Sprint(value), nil
	}
}

func projectionInt64(value interface{}) (int64, error) {
	switch typed := value.(type) {
	case int:
		return int64(typed), nil
	case int8:
		return int64(typed), nil
	case int16:
		return int64(typed), nil
	case int32:
		return int64(typed), nil
	case int64:
		return typed, nil
	case uint:
		if uint64(typed) > math.MaxInt64 {
			return 0, errors.New("整数超出 int64 范围")
		}
		return int64(typed), nil
	case uint8:
		return int64(typed), nil
	case uint16:
		return int64(typed), nil
	case uint32:
		return int64(typed), nil
	case uint64:
		if typed > math.MaxInt64 {
			return 0, errors.New("整数超出 int64 范围")
		}
		return int64(typed), nil
	case float32:
		return projectionFloatInt64(float64(typed))
	case float64:
		return projectionFloatInt64(typed)
	case json.Number:
		return strconv.ParseInt(strings.TrimSpace(typed.String()), 10, 64)
	case string:
		return strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
	case []byte:
		return strconv.ParseInt(strings.TrimSpace(string(typed)), 10, 64)
	default:
		return 0, fmt.Errorf("无法把 %T 转为 int64", value)
	}
}

func projectionFloatInt64(value float64) (int64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value || value < math.MinInt64 || value > math.MaxInt64 {
		return 0, errors.New("浮点值不是有效的 int64")
	}
	return int64(value), nil
}

func projectionDecimal(value interface{}) (json.Number, error) {
	var text string
	switch typed := value.(type) {
	case json.Number:
		text = typed.String()
	case string:
		text = typed
	case []byte:
		text = string(typed)
	case int:
		text = strconv.FormatInt(int64(typed), 10)
	case int8:
		text = strconv.FormatInt(int64(typed), 10)
	case int16:
		text = strconv.FormatInt(int64(typed), 10)
	case int32:
		text = strconv.FormatInt(int64(typed), 10)
	case int64:
		text = strconv.FormatInt(typed, 10)
	case uint:
		text = strconv.FormatUint(uint64(typed), 10)
	case uint8:
		text = strconv.FormatUint(uint64(typed), 10)
	case uint16:
		text = strconv.FormatUint(uint64(typed), 10)
	case uint32:
		text = strconv.FormatUint(uint64(typed), 10)
	case uint64:
		text = strconv.FormatUint(typed, 10)
	case float32:
		text = strconv.FormatFloat(float64(typed), 'g', -1, 32)
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return "", errors.New("无效 decimal 浮点值")
		}
		text = strconv.FormatFloat(typed, 'g', -1, 64)
	default:
		return "", fmt.Errorf("无法把 %T 转为 decimal", value)
	}
	text = strings.TrimSpace(text)
	if !projectionDecimalPattern.MatchString(text) {
		return "", errors.New("无效 decimal 文本")
	}
	return json.Number(text), nil
}

func projectionBool(value interface{}) (bool, error) {
	switch typed := value.(type) {
	case bool:
		return typed, nil
	case int:
		return projectionNumericBool(int64(typed))
	case int8:
		return projectionNumericBool(int64(typed))
	case int16:
		return projectionNumericBool(int64(typed))
	case int32:
		return projectionNumericBool(int64(typed))
	case int64:
		return projectionNumericBool(typed)
	case uint:
		return projectionUnsignedBool(uint64(typed))
	case uint8:
		return projectionUnsignedBool(uint64(typed))
	case uint16:
		return projectionUnsignedBool(uint64(typed))
	case uint32:
		return projectionUnsignedBool(uint64(typed))
	case uint64:
		return projectionUnsignedBool(typed)
	case string:
		return projectionTextBool(typed)
	case []byte:
		return projectionTextBool(string(typed))
	case json.Number:
		return projectionTextBool(typed.String())
	default:
		return false, fmt.Errorf("无法把 %T 转为 bool", value)
	}
}

func projectionNumericBool(value int64) (bool, error) {
	if value == 0 {
		return false, nil
	}
	if value == 1 {
		return true, nil
	}
	return false, errors.New("bool 数值只能是 0 或 1")
}

func projectionUnsignedBool(value uint64) (bool, error) {
	if value > 1 {
		return false, errors.New("bool 数值只能是 0 或 1")
	}
	return value == 1, nil
}

func projectionTextBool(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "y", "on":
		return true, nil
	case "0", "false", "no", "n", "off":
		return false, nil
	default:
		return false, errors.New("无效 bool 文本")
	}
}

func projectionTime(value interface{}, transform SyncValueTransform, dateOnly bool) (time.Time, error) {
	location := time.UTC
	if timezone := strings.TrimSpace(transform.Args["timezone"]); timezone != "" {
		loaded, err := time.LoadLocation(timezone)
		if err != nil {
			return time.Time{}, err
		}
		location = loaded
	}
	var parsed time.Time
	switch typed := value.(type) {
	case time.Time:
		parsed = typed.In(location)
	case string:
		valueText := strings.TrimSpace(typed)
		layout := strings.TrimSpace(transform.Args["layout"])
		var err error
		if layout != "" {
			parsed, err = time.ParseInLocation(layout, valueText, location)
		} else {
			parsed, err = parseProjectionTimeText(valueText, location)
		}
		if err != nil {
			return time.Time{}, err
		}
	case []byte:
		return projectionTime(string(typed), transform, dateOnly)
	default:
		return time.Time{}, fmt.Errorf("无法把 %T 转为时间", value)
	}
	if dateOnly {
		year, month, day := parsed.Date()
		return time.Date(year, month, day, 0, 0, 0, 0, location), nil
	}
	return parsed, nil
}

func parseProjectionTimeText(value string, location *time.Location) (time.Time, error) {
	zoneLayouts := []string{time.RFC3339Nano, time.RFC3339}
	for _, layout := range zoneLayouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.In(location), nil
		}
	}
	localLayouts := []string{
		"2006-01-02 15:04:05.999999999",
		"2006-01-02T15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05",
		"2006-01-02",
	}
	for _, layout := range localLayouts {
		if parsed, err := time.ParseInLocation(layout, value, location); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, errors.New("无法识别日期或时间格式")
}

func projectionJSON(value interface{}) (interface{}, error) {
	var encoded []byte
	switch typed := value.(type) {
	case string:
		encoded = []byte(typed)
	case []byte:
		encoded = append([]byte(nil), typed...)
	case json.RawMessage:
		encoded = append([]byte(nil), typed...)
	default:
		var err error
		encoded, err = json.Marshal(value)
		if err != nil {
			return nil, err
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var decoded interface{}
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, errors.New("JSON 包含多个顶层值")
		}
		return nil, err
	}
	return decoded, nil
}

func cloneProjectionRow(row map[string]interface{}) map[string]interface{} {
	if row == nil {
		return nil
	}
	cloned := make(map[string]interface{}, len(row))
	for key, value := range row {
		cloned[key] = value
	}
	return cloned
}

func cloneProjectionValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}, []interface{}:
		cloned, err := projectionJSON(typed)
		if err == nil {
			return cloned
		}
	case []byte:
		return append([]byte(nil), typed...)
	}
	return value
}
