package hivesql

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var numberPattern = regexp.MustCompile("^[+-]?[0-9]+(?:[.][0-9]*)?(?:[eE][+-]?[0-9]+)?$")

// Value renders one typed Hive expression. DECIMAL accepts exact text or integers,
// not floating point. Complex values accept JSON text or native slices/maps.
// BINARY strings are UTF-8 bytes, except an explicit 0x prefix denotes hex.
func Value(typeName string, value any) (string, error) {
	t, err := ParseType(typeName)
	if err != nil {
		return "", err
	}
	return typedValue(t, value, 0)
}

// QuoteString escapes Hive's backslash-aware string grammar.
func QuoteString(text string) string {
	r := strings.NewReplacer("\\", "\\\\", "'", "\\'", "\x00", "\\0", "\n", "\\n", "\r", "\\r", "\t", "\\t", "\b", "\\b", "\x1a", "\\Z")
	return "'" + r.Replace(text) + "'"
}

func typedValue(t Type, value any, depth int) (string, error) {
	if depth > 32 {
		return "", fmt.Errorf("Hive value nesting exceeds 32")
	}
	if value == nil {
		return "CAST(NULL AS " + t.String() + ")", nil
	}
	if t.Complex() {
		return collectionValue(t, value, depth)
	}
	switch t.Kind {
	case "void":
		return "", fmt.Errorf("non-null Hive VOID value")
	case "decimal":
		return decimalValue(t, value)
	case "tinyint", "smallint", "int", "bigint":
		return integerValue(t, value)
	case "float", "double":
		text, err := numericText(value, true)
		if err != nil {
			return "", err
		}
		n, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return "", fmt.Errorf("non-finite Hive number")
		}
		return "CAST(" + text + " AS " + t.String() + ")", nil
	case "boolean":
		switch v := value.(type) {
		case bool:
			if v {
				return "TRUE", nil
			}
			return "FALSE", nil
		case string:
			switch strings.ToLower(strings.TrimSpace(v)) {
			case "true", "1":
				return "TRUE", nil
			case "false", "0":
				return "FALSE", nil
			}
		}
		return "", fmt.Errorf("invalid Hive BOOLEAN value")
	case "binary":
		return binaryValue(value)
	case "interval_year_month", "interval_day_time":
		return intervalValue(t, value)
	case "string", "char", "varchar":
		text, err := scalarText(value)
		if err != nil {
			return "", err
		}
		if t.Length > 0 && utf8.RuneCountInString(text) > t.Length {
			return "", fmt.Errorf("Hive %s value exceeds declared length", t.Kind)
		}
		if strings.Contains(text, "${") {
			return "decode(unhex('" + hex.EncodeToString([]byte(text)) + "'), 'UTF-8')", nil
		}
		return QuoteString(text), nil
	case "date", "timestamp", "timestamp_local_tz":
		return temporalValue(t, value)
	default:
		return "", fmt.Errorf("Hive literal for %s is not supported", t.String())
	}
}

func scalarText(value any) (string, error) {
	switch v := value.(type) {
	case string:
		return v, nil
	case []byte:
		if !utf8.Valid(v) {
			return "", fmt.Errorf("invalid UTF-8 Hive string")
		}
		return string(v), nil
	case json.Number:
		return v.String(), nil
	case bool:
		return strconv.FormatBool(v), nil
	case time.Time:
		return v.Format("2006-01-02 15:04:05.999999999"), nil
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.FormatInt(rv.Int(), 10), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return strconv.FormatUint(rv.Uint(), 10), nil
	case reflect.Float32, reflect.Float64:
		n := rv.Float()
		if !math.IsNaN(n) && !math.IsInf(n, 0) {
			return strconv.FormatFloat(n, 'g', -1, 64), nil
		}
	}
	return "", fmt.Errorf("unsupported Hive scalar value %T", value)
}

func numericText(value any, allowFloat bool) (string, error) {
	if !allowFloat {
		switch value.(type) {
		case float32, float64:
			return "", fmt.Errorf("Hive exact numeric values require integers or decimal text")
		}
	}
	text, err := scalarText(value)
	if err != nil {
		return "", err
	}
	text = strings.TrimSpace(text)
	if len(text) > 1024 || !numberPattern.MatchString(text) {
		return "", fmt.Errorf("invalid Hive numeric literal")
	}
	return text, nil
}

func integerValue(t Type, value any) (string, error) {
	text, err := numericText(value, false)
	if err != nil {
		return "", err
	}
	bits := 64
	switch t.Kind {
	case "tinyint":
		bits = 8
	case "smallint":
		bits = 16
	case "int":
		bits = 32
	}
	n, err := strconv.ParseInt(text, 10, bits)
	if err != nil {
		return "", fmt.Errorf("Hive integer out of range: %w", err)
	}
	return "CAST(" + strconv.FormatInt(n, 10) + " AS " + t.String() + ")", nil
}

func decimalValue(t Type, value any) (string, error) {
	text, err := numericText(value, false)
	if err != nil {
		return "", err
	}
	text, err = expandDecimal(text)
	if err != nil {
		return "", err
	}
	unsigned := strings.TrimLeft(text, "+-")
	integer, fraction, _ := strings.Cut(unsigned, ".")
	if len(strings.TrimLeft(integer, "0")) > t.Precision-t.Scale || len(strings.TrimRight(fraction, "0")) > t.Scale {
		return "", fmt.Errorf("Hive DECIMAL value exceeds precision or scale")
	}
	return "CAST(" + QuoteString(text) + " AS " + t.String() + ")", nil
}

func expandDecimal(text string) (string, error) {
	sign := ""
	if text[0] == '-' || text[0] == '+' {
		if text[0] == '-' {
			sign = "-"
		}
		text = text[1:]
	}
	coefficient, exponentText, hasExponent := strings.Cut(strings.ToLower(text), "e")
	exponent := 0
	if hasExponent {
		n, err := strconv.Atoi(exponentText)
		if err != nil || n > 1024 || n < -1024 {
			return "", fmt.Errorf("Hive DECIMAL exponent out of range")
		}
		exponent = n
	}
	integer, fraction, _ := strings.Cut(coefficient, ".")
	digits := integer + fraction
	point := len(integer) + exponent
	if point <= 0 {
		return sign + "0." + strings.Repeat("0", -point) + digits, nil
	}
	if point >= len(digits) {
		return sign + digits + strings.Repeat("0", point-len(digits)), nil
	}
	return sign + digits[:point] + "." + digits[point:], nil
}

func binaryValue(value any) (string, error) {
	var raw []byte
	switch v := value.(type) {
	case []byte:
		raw = v
	case string:
		if strings.HasPrefix(v, "0x") {
			var err error
			raw, err = hex.DecodeString(v[2:])
			if err != nil {
				return "", fmt.Errorf("invalid Hive binary hex: %w", err)
			}
		} else {
			raw = []byte(v)
		}
	default:
		return "", fmt.Errorf("Hive BINARY requires bytes or text")
	}
	return "unhex('" + hex.EncodeToString(raw) + "')", nil
}

func temporalValue(t Type, value any) (string, error) {
	if t.Kind == "timestamp_local_tz" {
		return timestampTZValue(value)
	}
	var text string
	if v, ok := value.(time.Time); ok {
		if t.Kind == "date" {
			text = v.Format("2006-01-02")
		} else {
			text = v.Format("2006-01-02 15:04:05.999999999")
		}
	} else {
		var err error
		text, err = scalarText(value)
		if err != nil {
			return "", err
		}
	}
	layouts := []string{"2006-01-02"}
	if t.Kind != "date" {
		layouts = []string{"2006-01-02 15:04:05.999999999", "2006-01-02T15:04:05.999999999", time.RFC3339Nano}
	}
	valid := false
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, text); err == nil {
			valid = true
			if layout == time.RFC3339Nano {
				if parsed.Location() != time.UTC && strings.HasSuffix(text, "Z") == false {
					return "", fmt.Errorf("Hive timestamp cannot preserve an explicit non-UTC offset")
				}
				text = parsed.UTC().Format("2006-01-02 15:04:05.999999999")
			}
			break
		}
	}
	if !valid {
		return "", fmt.Errorf("invalid Hive %s value", t.Kind)
	}
	return "CAST(" + QuoteString(strings.Replace(text, "T", " ", 1)) + " AS " + t.String() + ")", nil
}

func decodeCollection(value any) (any, error) {
	var raw []byte
	switch v := value.(type) {
	case string:
		raw = []byte(v)
	case json.RawMessage:
		raw = v
	case []byte:
		raw = v
	default:
		return value, nil
	}
	if len(raw) > 16<<20 {
		return nil, fmt.Errorf("Hive collection exceeds 16 MiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var out any
	if err := decoder.Decode(&out); err != nil {
		return nil, fmt.Errorf("decode Hive collection: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("trailing Hive collection JSON")
	}
	return out, nil
}

func collectionValue(t Type, value any, depth int) (string, error) {
	if t.Kind == "uniontype" {
		return unionValue(t, value, depth)
	}
	decoded, err := decodeCollection(value)
	if err != nil {
		return "", err
	}
	if decoded == nil {
		return "CAST(NULL AS " + t.String() + ")", nil
	}
	switch t.Kind {
	case "array":
		rv := reflect.ValueOf(decoded)
		if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
			return "", fmt.Errorf("Hive ARRAY requires an array")
		}
		parts := make([]string, rv.Len())
		for i := 0; i < rv.Len(); i++ {
			parts[i], err = typedValue(*t.Element, rv.Index(i).Interface(), depth+1)
			if err != nil {
				return "", err
			}
		}
		return "CAST(array(" + strings.Join(parts, ", ") + ") AS " + t.String() + ")", nil
	case "map":
		return mapValue(t, decoded, depth)
	case "struct":
		return structValue(t, decoded, depth)
	}
	return "", fmt.Errorf("unsupported Hive collection")
}

func mapValue(t Type, value any, depth int) (string, error) {
	rv := reflect.ValueOf(value)
	if rv.Kind() != reflect.Map {
		return "", fmt.Errorf("Hive MAP requires a map")
	}
	type entry struct {
		key   string
		value string
	}
	entries := make([]entry, 0, rv.Len())
	iter := rv.MapRange()
	for iter.Next() {
		k, err := typedValue(*t.Key, iter.Key().Interface(), depth+1)
		if err != nil {
			return "", err
		}
		v, err := typedValue(*t.Value, iter.Value().Interface(), depth+1)
		if err != nil {
			return "", err
		}
		entries = append(entries, entry{key: k, value: v})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].key < entries[j].key })
	parts := make([]string, 0, len(entries)*2)
	for _, entry := range entries {
		parts = append(parts, entry.key, entry.value)
	}
	return "CAST(map(" + strings.Join(parts, ", ") + ") AS " + t.String() + ")", nil
}

func structValue(t Type, value any, depth int) (string, error) {
	fields, ok := value.(map[string]any)
	if !ok {
		return "", fmt.Errorf("Hive STRUCT requires an object")
	}
	if len(fields) != len(t.Fields) {
		return "", fmt.Errorf("Hive STRUCT fields do not match declared type")
	}
	parts := make([]string, 0, len(t.Fields)*2)
	for _, field := range t.Fields {
		v, found := fields[field.Name]
		if !found {
			return "", fmt.Errorf("missing Hive STRUCT field %q", field.Name)
		}
		literal, err := typedValue(field.Type, v, depth+1)
		if err != nil {
			return "", err
		}
		parts = append(parts, QuoteString(field.Name), literal)
	}
	return "CAST(named_struct(" + strings.Join(parts, ", ") + ") AS " + t.String() + ")", nil
}
