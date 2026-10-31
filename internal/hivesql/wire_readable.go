package hivesql

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// NormalizeReadableValue decodes HiveServer2 SerDe text using its complete source
// type, returning compact JSON with exact numeric tokens and typed object keys.
// It never repairs binary display text: ValidateReadableType rejects that schema
// before parsing, even if the payload happens to look like valid JSON.
func NormalizeReadableValue(typeName, raw string) (string, error) {
	typ, err := ParseType(typeName)
	if err != nil {
		return "", err
	}
	if err := ValidateReadableType(typeName); err != nil {
		return "", err
	}
	if typ.Kind == "binary" {
		return "", fmt.Errorf("Hive BINARY requires the native binary result vector")
	}
	if len(raw) > 16<<20 || !utf8.ValidString(raw) {
		return "", fmt.Errorf("Hive SerDe text exceeds 16 MiB or is not valid UTF-8")
	}
	reader := wireReader{text: raw}
	value, err := reader.value(typ, 0)
	if err != nil {
		return "", fmt.Errorf("decode Hive SerDe %s at byte %d: %w", typ.String(), reader.pos, err)
	}
	reader.space()
	if reader.pos != len(raw) {
		return "", fmt.Errorf("trailing Hive SerDe text at byte %d", reader.pos)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode normalized Hive SerDe value: %w", err)
	}
	return string(encoded), nil
}

type wireReader struct {
	text string
	pos  int
}

func (p *wireReader) space() {
	for p.pos < len(p.text) && strings.ContainsRune(" \t\r\n", rune(p.text[p.pos])) {
		p.pos++
	}
}

func (p *wireReader) take(c byte) bool {
	p.space()
	if p.pos < len(p.text) && p.text[p.pos] == c {
		p.pos++
		return true
	}
	return false
}

func (p *wireReader) expect(c byte) error {
	if !p.take(c) {
		return fmt.Errorf("expected %q", c)
	}
	return nil
}

func (p *wireReader) value(typ Type, depth int) (any, error) {
	if depth > 32 {
		return nil, fmt.Errorf("Hive SerDe nesting exceeds 32")
	}
	p.space()
	if strings.HasPrefix(p.text[p.pos:], "null") {
		end := p.pos + 4
		if end == len(p.text) || strings.ContainsRune(" \t\r\n,]}", rune(p.text[end])) {
			p.pos = end
			return nil, nil
		}
	}
	switch typ.Kind {
	case "array":
		return p.array(typ, depth)
	case "map", "struct":
		return p.object(typ, depth)
	case "uniontype":
		return p.union(typ, depth)
	default:
		return p.primitive(typ, false)
	}
}

func (p *wireReader) array(typ Type, depth int) (any, error) {
	if err := p.expect('['); err != nil {
		return nil, err
	}
	out := make([]any, 0)
	if p.take(']') {
		return out, nil
	}
	for {
		member, err := p.value(*typ.Element, depth+1)
		if err != nil {
			return nil, err
		}
		out = append(out, member)
		if p.take(']') {
			return out, nil
		}
		if err := p.expect(','); err != nil {
			return nil, err
		}
	}
}

func (p *wireReader) object(typ Type, depth int) (any, error) {
	if err := p.expect('{'); err != nil {
		return nil, err
	}
	out := make(map[string]any)
	if !p.take('}') {
		for {
			key, memberType, err := p.objectKey(typ)
			if err != nil {
				return nil, err
			}
			if _, duplicate := out[key]; duplicate {
				return nil, fmt.Errorf("duplicate Hive object key")
			}
			if err := p.expect(':'); err != nil {
				return nil, err
			}
			member, err := p.value(memberType, depth+1)
			if err != nil {
				return nil, err
			}
			out[key] = member
			if p.take('}') {
				break
			}
			if err := p.expect(','); err != nil {
				return nil, err
			}
		}
	}
	if typ.Kind == "struct" && len(out) != len(typ.Fields) {
		return nil, fmt.Errorf("Hive STRUCT fields do not match source type")
	}
	return out, nil
}

func (p *wireReader) objectKey(typ Type) (string, Type, error) {
	if typ.Kind == "struct" {
		key, err := p.quoted()
		if err != nil {
			return "", Type{}, err
		}
		for _, field := range typ.Fields {
			if key == field.Name {
				return key, field.Type, nil
			}
		}
		return "", Type{}, fmt.Errorf("unknown Hive STRUCT field")
	}
	key, err := p.primitive(*typ.Key, true)
	if err != nil {
		return "", Type{}, err
	}
	text, err := NormalizePrimitiveMapKey(*typ.Key, key)
	return text, *typ.Value, err
}

func (p *wireReader) union(typ Type, depth int) (any, error) {
	if err := p.expect('{'); err != nil {
		return nil, err
	}
	rawTag, err := p.primitive(Type{Kind: "int"}, true)
	if err != nil {
		return nil, err
	}
	text, err := NormalizePrimitiveMapKey(Type{Kind: "int"}, rawTag)
	if err != nil {
		return nil, err
	}
	tag, err := strconv.Atoi(text)
	if err != nil || tag < 0 || tag >= len(typ.Members) {
		return nil, fmt.Errorf("Hive UNIONTYPE tag is out of range")
	}
	if err := p.expect(':'); err != nil {
		return nil, err
	}
	member, err := p.value(typ.Members[tag], depth+1)
	if err != nil {
		return nil, err
	}
	if err := p.expect('}'); err != nil {
		return nil, err
	}
	return map[string]any{text: member}, nil
}

func (p *wireReader) primitive(typ Type, key bool) (any, error) {
	p.space()
	if p.pos >= len(p.text) {
		return nil, fmt.Errorf("missing Hive primitive")
	}
	if p.text[p.pos] == '"' {
		text, err := p.quoted()
		if err != nil {
			return nil, err
		}
		if !key {
			switch typ.Kind {
			case "string", "char", "varchar", "date", "timestamp", "timestamp_local_tz", "interval_year_month", "interval_day_time":
			default:
				return nil, fmt.Errorf("quoted Hive numeric or boolean value")
			}
		}
		if _, err := typedValue(typ, text, 0); err != nil {
			return nil, err
		}
		if (typ.Kind == "timestamp" || typ.Kind == "timestamp_local_tz") && !timestampNanosecondsExact(text) {
			return nil, fmt.Errorf("Hive timestamp precision exceeds nanoseconds")
		}
		return text, nil
	}
	start := p.pos
	for p.pos < len(p.text) && !strings.ContainsRune(" \t\r\n,:]}", rune(p.text[p.pos])) {
		p.pos++
	}
	text := p.text[start:p.pos]
	if typ.Kind == "boolean" && (text == "true" || text == "false") {
		return text == "true", nil
	}
	switch typ.Kind {
	case "tinyint", "smallint", "int", "bigint", "decimal", "float", "double":
		if !numberPattern.MatchString(text) || !json.Valid([]byte(text)) {
			return nil, fmt.Errorf("invalid Hive numeric token")
		}
		value := json.Number(text)
		if _, err := typedValue(typ, value, 0); err != nil {
			return nil, err
		}
		return value, nil
	default:
		return nil, fmt.Errorf("invalid Hive primitive token for %s", typ.String())
	}
}
