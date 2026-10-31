// Package hivesql provides strict, pure-Go Hive types and SQL literals.
package hivesql

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Type preserves a validated Hive type, including nested collection members.
type Type struct {
	Kind      string
	Precision int
	Scale     int
	Length    int
	Element   *Type
	Key       *Type
	Value     *Type
	Fields    []Field
	Members   []Type
}

// Field is one named member of a STRUCT.
type Field struct {
	Name string
	Type Type
}

// ParseType parses a complete type and rejects trailing SQL and excessive nesting.
func ParseType(raw string) (Type, error) {
	if len(raw) > 65536 {
		return Type{}, fmt.Errorf("hive type is too long")
	}
	p := typeParser{text: raw}
	result, err := p.parse(0)
	if err != nil {
		return Type{}, err
	}
	p.space()
	if p.pos != len(p.text) {
		return Type{}, fmt.Errorf("unexpected Hive type suffix at byte %d", p.pos)
	}
	return result, nil
}

// NormalizeType validates a type and returns its canonical representation.
func NormalizeType(raw string) (string, error) {
	t, err := ParseType(raw)
	if err != nil {
		return "", err
	}
	return t.String(), nil
}

// String returns a canonical Hive type, not arbitrary SQL supplied by callers.
func (t Type) String() string {
	switch t.Kind {
	case "decimal":
		return fmt.Sprintf("DECIMAL(%d,%d)", t.Precision, t.Scale)
	case "char", "varchar":
		return fmt.Sprintf("%s(%d)", strings.ToUpper(t.Kind), t.Length)
	case "array":
		if t.Element != nil {
			return "ARRAY<" + t.Element.String() + ">"
		}
	case "map":
		if t.Key != nil && t.Value != nil {
			return "MAP<" + t.Key.String() + "," + t.Value.String() + ">"
		}
	case "struct":
		fields := make([]string, len(t.Fields))
		for i, f := range t.Fields {
			fields[i] = QuoteIdentifier(f.Name) + ":" + f.Type.String()
		}
		return "STRUCT<" + strings.Join(fields, ",") + ">"
	case "interval_year_month":
		return "INTERVAL YEAR TO MONTH"
	case "interval_day_time":
		return "INTERVAL DAY TO SECOND"
	case "uniontype":
		members := make([]string, len(t.Members))
		for i, member := range t.Members {
			members[i] = member.String()
		}
		return "UNIONTYPE<" + strings.Join(members, ",") + ">"
	case "timestamp_local_tz":
		return "TIMESTAMP WITH LOCAL TIME ZONE"
	}
	return strings.ToUpper(t.Kind)
}

// Complex reports whether a type requires Hive collection constructors.
func (t Type) Complex() bool {
	return t.Kind == "array" || t.Kind == "map" || t.Kind == "struct" || t.Kind == "uniontype"
}

// QuoteIdentifier quotes exactly one identifier, never a SQL expression.
func QuoteIdentifier(name string) string { return "`" + strings.ReplaceAll(name, "`", "``") + "`" }

// QuoteTable quotes dot-separated qualified names, respecting quoted dots.
// Callers that already have separate database and table names should quote them separately.
func QuoteTable(name string) string {
	parts, err := SplitTable(name)
	if err != nil {
		return QuoteIdentifier(name)
	}
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = QuoteIdentifier(part)
	}
	return strings.Join(quoted, ".")
}

// SplitTable validates a one- or two-part Hive table identity.
func SplitTable(name string) ([]string, error) {
	p := typeParser{text: strings.TrimSpace(name)}
	var parts []string
	for {
		part, err := p.ident()
		if err != nil || part == "" {
			return nil, fmt.Errorf("invalid Hive table identity")
		}
		parts = append(parts, part)
		p.space()
		if p.pos == len(p.text) {
			break
		}
		if len(parts) >= 2 || !p.take('.') {
			return nil, fmt.Errorf("invalid Hive table identity")
		}
	}
	return parts, nil
}

type typeParser struct {
	text string
	pos  int
}

func (p *typeParser) space() {
	for p.pos < len(p.text) && unicode.IsSpace(rune(p.text[p.pos])) {
		p.pos++
	}
}
func (p *typeParser) take(c byte) bool {
	p.space()
	if p.pos < len(p.text) && p.text[p.pos] == c {
		p.pos++
		return true
	}
	return false
}
func (p *typeParser) expect(c byte) error {
	if !p.take(c) {
		return fmt.Errorf("expected %q in Hive type at byte %d", c, p.pos)
	}
	return nil
}
func (p *typeParser) ident() (string, error) {
	p.space()
	start := p.pos
	if p.take('`') {
		var out strings.Builder
		for p.pos < len(p.text) {
			c := p.text[p.pos]
			p.pos++
			if c == '`' {
				if p.pos < len(p.text) && p.text[p.pos] == '`' {
					out.WriteByte('`')
					p.pos++
					continue
				}
				return out.String(), nil
			}
			out.WriteByte(c)
		}
		return "", fmt.Errorf("unterminated Hive identifier")
	}
	for p.pos < len(p.text) {
		c := p.text[p.pos]
		if c != '_' && !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && c < 128 {
			break
		}
		p.pos++
	}
	if p.pos == start {
		return "", fmt.Errorf("expected Hive identifier at byte %d", start)
	}
	return p.text[start:p.pos], nil
}
func (p *typeParser) number() (int, error) {
	p.space()
	start := p.pos
	for p.pos < len(p.text) && p.text[p.pos] >= '0' && p.text[p.pos] <= '9' {
		p.pos++
	}
	if start == p.pos {
		return 0, fmt.Errorf("expected Hive type size")
	}
	n, err := strconv.Atoi(p.text[start:p.pos])
	if err != nil {
		return 0, fmt.Errorf("invalid Hive type size: %w", err)
	}
	return n, nil
}
func (p *typeParser) parse(depth int) (Type, error) {
	if depth > 32 {
		return Type{}, fmt.Errorf("Hive type nesting exceeds 32")
	}
	name, err := p.ident()
	if err != nil {
		return Type{}, err
	}
	t := Type{Kind: strings.ToLower(name)}
	switch t.Kind {
	case "integer":
		t.Kind = "int"
	case "bool":
		t.Kind = "boolean"
	case "numeric":
		t.Kind = "decimal"
	}
	switch t.Kind {
	case "void", "boolean", "tinyint", "smallint", "int", "bigint", "float", "double", "string", "binary", "date", "interval_year_month", "interval_day_time":
	case "interval":
		unit, e := p.ident()
		if e != nil {
			return Type{}, e
		}
		to, e := p.ident()
		if e != nil {
			return Type{}, e
		}
		end, e := p.ident()
		if e != nil {
			return Type{}, e
		}
		switch strings.ToLower(unit + " " + to + " " + end) {
		case "year to month":
			t.Kind = "interval_year_month"
		case "day to second":
			t.Kind = "interval_day_time"
		default:
			return Type{}, fmt.Errorf("unsupported Hive interval type")
		}
	case "timestamp":
		saved := p.pos
		p.space()
		if strings.HasPrefix(strings.ToLower(p.text[p.pos:]), "with local time zone") {
			p.pos += len("with local time zone")
			t.Kind = "timestamp_local_tz"
		} else {
			p.pos = saved
		}
	case "decimal":
		t.Precision = 10
		if p.take('(') {
			t.Precision, err = p.number()
			if err == nil && p.take(',') {
				t.Scale, err = p.number()
			}
			if err == nil {
				err = p.expect(')')
			}
		}
		if err == nil && (t.Precision < 1 || t.Precision > 38 || t.Scale < 0 || t.Scale > t.Precision) {
			err = fmt.Errorf("invalid Hive DECIMAL precision or scale")
		}
	case "char", "varchar":
		if err = p.expect('('); err == nil {
			t.Length, err = p.number()
		}
		if err == nil {
			err = p.expect(')')
		}
		max := 65535
		if t.Kind == "char" {
			max = 255
		}
		if err == nil && (t.Length < 1 || t.Length > max) {
			err = fmt.Errorf("invalid Hive character length")
		}
	case "array", "map":
		if err = p.expect('<'); err != nil {
			break
		}
		member, e := p.parse(depth + 1)
		if e != nil {
			err = e
			break
		}
		if t.Kind == "array" {
			t.Element = &member
		} else {
			t.Key = &member
			if member.Complex() || member.Kind == "void" {
				return Type{}, fmt.Errorf("Hive MAP keys must be primitive")
			}
			if err = p.expect(','); err != nil {
				break
			}
			value, e := p.parse(depth + 1)
			if e != nil {
				err = e
				break
			}
			t.Value = &value
		}
		err = p.expect('>')
	case "struct":
		err = p.structure(&t, depth)
	case "uniontype":
		err = p.union(&t, depth)
	default:
		err = fmt.Errorf("unsupported Hive type %q", name)
	}
	if err != nil {
		return Type{}, err
	}
	return t, nil
}
func (p *typeParser) structure(t *Type, depth int) error {
	if err := p.expect('<'); err != nil {
		return err
	}
	seen := map[string]bool{}
	for {
		name, err := p.ident()
		if err != nil {
			return err
		}
		if name == "" || seen[strings.ToLower(name)] {
			return fmt.Errorf("empty or duplicate Hive STRUCT field")
		}
		seen[strings.ToLower(name)] = true
		if err = p.expect(':'); err != nil {
			return err
		}
		field, err := p.parse(depth + 1)
		if err != nil {
			return err
		}
		t.Fields = append(t.Fields, Field{Name: name, Type: field})
		if p.take('>') {
			return nil
		}
		if err = p.expect(','); err != nil {
			return err
		}
	}
}
