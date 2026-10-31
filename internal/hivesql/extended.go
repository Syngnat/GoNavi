package hivesql

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

func (p *typeParser) union(t *Type, depth int) error {
	if err := p.expect('<'); err != nil {
		return err
	}
	for {
		if len(t.Members) >= 128 {
			return fmt.Errorf("Hive UNIONTYPE exceeds 128 alternatives")
		}
		member, err := p.parse(depth + 1)
		if err != nil {
			return err
		}
		t.Members = append(t.Members, member)
		if p.take('>') {
			return nil
		}
		if err = p.expect(','); err != nil {
			return err
		}
	}
}

var hiveUnionTagPattern = regexp.MustCompile("^([[:space:]]*[{][[:space:]]*)([0-9]+)([[:space:]]*:)")
var hiveYearMonthPattern = regexp.MustCompile("^[+-]?([0-9]+)-([0-9]{1,2})$")
var hiveDayTimePattern = regexp.MustCompile("^[+-]?([0-9]+) ([0-9]{1,2}):([0-9]{2}):([0-9]{2})([.][0-9]{1,9})?$")

// UnionValue is an explicit tagged input representation for UNIONTYPE literals.
type UnionValue struct {
	Tag   int
	Value any
}

func unionValue(t Type, value any, depth int) (string, error) {
	tag := -1
	var memberValue any
	if explicit, ok := value.(UnionValue); ok {
		tag, memberValue = explicit.Tag, explicit.Value
	} else {
		if text, ok := value.(string); ok {
			text = hiveUnionTagPattern.ReplaceAllString(text, "$"+"{1}\""+"$"+"{2}\""+"$"+"{3}")
			value = text
		}
		decoded, err := decodeCollection(value)
		if err != nil {
			return "", err
		}
		fields, ok := decoded.(map[string]any)
		if !ok {
			return "", fmt.Errorf("Hive UNIONTYPE requires explicit tag/value")
		}
		if rawTag, found := fields["tag"]; found && len(fields) == 2 {
			if _, ok := fields["value"]; !ok {
				return "", fmt.Errorf("Hive UNIONTYPE value is missing")
			}
			text, err := numericText(rawTag, false)
			if err != nil {
				return "", err
			}
			tag, err = strconv.Atoi(text)
			if err != nil {
				return "", fmt.Errorf("invalid Hive UNIONTYPE tag")
			}
			memberValue = fields["value"]
		} else if len(fields) == 1 {
			for key, v := range fields {
				var err error
				tag, err = strconv.Atoi(key)
				if err != nil {
					return "", fmt.Errorf("invalid Hive UNIONTYPE tag")
				}
				memberValue = v
			}
		} else {
			return "", fmt.Errorf("Hive UNIONTYPE requires exactly one tagged value")
		}
	}
	if tag < 0 || tag >= len(t.Members) {
		return "", fmt.Errorf("Hive UNIONTYPE tag is out of range")
	}
	parts := make([]string, len(t.Members)+1)
	parts[0] = strconv.Itoa(tag)
	for i, member := range t.Members {
		var v any
		if i == tag {
			v = memberValue
		}
		literal, err := typedValue(member, v, depth+1)
		if err != nil {
			return "", err
		}
		parts[i+1] = literal
	}
	return "create_union(" + strings.Join(parts, ", ") + ")", nil
}

func intervalValue(t Type, value any) (string, error) {
	text, err := scalarText(value)
	if err != nil {
		return "", err
	}
	if len(text) > 64 {
		return "", fmt.Errorf("Hive interval exceeds supported range")
	}
	if t.Kind == "interval_year_month" {
		parts := hiveYearMonthPattern.FindStringSubmatch(text)
		if parts == nil {
			return "", fmt.Errorf("Hive year-month interval requires [+|-]years-months")
		}
		years, err := strconv.ParseUint(parts[1], 10, 31)
		if err != nil {
			return "", fmt.Errorf("Hive interval years out of range")
		}
		months, _ := strconv.Atoi(parts[2])
		if months > 11 || years*12+uint64(months) > 2147483647 {
			return "", fmt.Errorf("Hive interval months out of range")
		}
		return "INTERVAL " + QuoteString(text) + " YEAR TO MONTH", nil
	}
	parts := hiveDayTimePattern.FindStringSubmatch(text)
	if parts == nil {
		return "", fmt.Errorf("Hive day-time interval requires [+|-]days hh:mm:ss[.nanoseconds]")
	}
	days, err := strconv.ParseUint(parts[1], 10, 63)
	if err != nil || days > 106751991167300 {
		return "", fmt.Errorf("Hive interval days out of range")
	}
	for i, max := range []int{23, 59, 59} {
		n, _ := strconv.Atoi(parts[i+2])
		if n > max {
			return "", fmt.Errorf("Hive interval time component out of range")
		}
	}
	return "INTERVAL " + QuoteString(text) + " DAY TO SECOND", nil
}
