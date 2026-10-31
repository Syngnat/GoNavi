package hivesql

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// NormalizePrimitiveMapKey makes a lossless JSON object key using the declared
// Hive key type. The same type restores primitive semantics when Value renders
// the object. Complex, nil, binary and invalid UTF-8 keys are never stringified.
func NormalizePrimitiveMapKey(typ Type, key any) (string, error) {
	if key == nil || typ.Complex() || typ.Kind == "void" || typ.Kind == "binary" {
		return "", fmt.Errorf("Hive MAP key must be a readable non-null primitive")
	}
	rv := reflect.ValueOf(key)
	switch rv.Kind() {
	case reflect.String:
		if !utf8.ValidString(rv.String()) {
			return "", fmt.Errorf("Hive MAP key is not valid UTF-8")
		}
		if _, number := key.(json.Number); !number {
			key = rv.String()
		}
	case reflect.Bool:
		key = rv.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		key = rv.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		key = rv.Uint()
	case reflect.Float32, reflect.Float64:
		if typ.Kind != "float" && typ.Kind != "double" && typ.Kind != "string" && typ.Kind != "char" && typ.Kind != "varchar" {
			return "", fmt.Errorf("Hive exact MAP keys cannot use floating point")
		}
	case reflect.Struct:
		if _, ok := key.(time.Time); !ok || (typ.Kind != "date" && typ.Kind != "timestamp" && typ.Kind != "timestamp_local_tz") {
			return "", fmt.Errorf("Hive MAP key must be primitive")
		}
	default:
		return "", fmt.Errorf("Hive MAP key must be primitive")
	}
	if _, err := typedValue(typ, key, 0); err != nil {
		return "", err
	}
	if typ.Kind == "timestamp_local_tz" {
		return timestampTZText(key)
	}
	if instant, ok := key.(time.Time); ok && typ.Kind == "date" {
		return instant.Format("2006-01-02"), nil
	}
	text, err := scalarText(key)
	if err != nil {
		return "", err
	}
	switch typ.Kind {
	case "tinyint", "smallint", "int", "bigint":
		n, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64)
		if err != nil {
			return "", fmt.Errorf("invalid Hive integer MAP key: %w", err)
		}
		return strconv.FormatInt(n, 10), nil
	case "boolean":
		return strconv.FormatBool(strings.EqualFold(strings.TrimSpace(text), "true") || strings.TrimSpace(text) == "1"), nil
	case "decimal":
		expanded, err := expandDecimal(strings.TrimSpace(text))
		if err != nil {
			return "", err
		}
		return wireDecimalIdentity(expanded), nil
	case "float", "double":
		bits := 64
		if typ.Kind == "float" {
			bits = 32
		}
		n, err := strconv.ParseFloat(strings.TrimSpace(text), bits)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return "", fmt.Errorf("non-finite Hive MAP key")
		}
		if n == 0 {
			return "0", nil
		}
		return strconv.FormatFloat(n, 'g', -1, bits), nil
	}
	return text, nil
}

func wireDecimalIdentity(text string) string {
	negative := strings.HasPrefix(text, "-")
	integer, fraction, _ := strings.Cut(strings.TrimLeft(text, "+-"), ".")
	integer = strings.TrimLeft(integer, "0")
	if integer == "" {
		integer = "0"
	}
	fraction = strings.TrimRight(fraction, "0")
	if fraction != "" {
		integer += "." + fraction
	}
	if negative && integer != "0" {
		integer = "-" + integer
	}
	return integer
}
