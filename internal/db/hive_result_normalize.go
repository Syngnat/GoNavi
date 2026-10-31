//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"fmt"

	"GoNavi-Wails/internal/hivesql"
)

func hiveNormalizeResultCell(value any, typeName string) (any, error) {
	if value == nil {
		return nil, nil
	}
	typ, err := hivesql.ParseType(typeName)
	if err != nil {
		return nil, err
	}
	if err := hivesql.ValidateReadableType(typeName); err != nil {
		return nil, err
	}
	if typ.Complex() {
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("Hive complex result requires source-typed SerDe text")
		}
		normalized, err := hivesql.NormalizeReadableValue(typeName, text)
		if err != nil {
			return nil, err
		}
		return normalized, nil
	}
	return hiveNormalizeValue(value, typ.String()), nil
}
