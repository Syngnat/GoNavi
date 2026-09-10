package runharness

import (
	"reflect"
	"testing"
	"time"
)

func TestJSONTimeFieldsHaveWailsStringTSType(t *testing.T) {
	samples := []any{
		RunSnapshot{},
		SessionProjection{},
		Message{},
		RunEvent{},
		TokenReservation{},
		WorkspaceSnapshot{},
		WorkspaceSQLActivity{},
		ToolCallRecord{},
		ApprovalRecord{},
		Checkpoint{},
		Lease{},
		ControlCommand{},
	}
	timeType := reflect.TypeOf(time.Time{})
	seen := map[reflect.Type]struct{}{}
	var walk func(typ reflect.Type)
	walk = func(typ reflect.Type) {
		for typ.Kind() == reflect.Ptr || typ.Kind() == reflect.Slice || typ.Kind() == reflect.Array {
			typ = typ.Elem()
		}
		if typ.Kind() != reflect.Struct {
			return
		}
		if _, ok := seen[typ]; ok {
			return
		}
		seen[typ] = struct{}{}
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			if !field.IsExported() {
				continue
			}
			jsonTag := field.Tag.Get("json")
			if jsonTag == "-" {
				continue
			}
			fieldType := field.Type
			for fieldType.Kind() == reflect.Ptr {
				fieldType = fieldType.Elem()
			}
			if fieldType == timeType {
				if field.Tag.Get("ts_type") != "string" {
					t.Errorf("%s.%s: json-exported time.Time must have ts_type:\"string\" so Wails does not log \"Not found: time.Time\"", typ.Name(), field.Name)
				}
				continue
			}
			walk(fieldType)
		}
	}
	for _, sample := range samples {
		walk(reflect.TypeOf(sample))
	}
}
