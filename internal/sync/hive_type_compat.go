package sync

import "GoNavi-Wails/internal/hivesql"

// A compatible existing target can widen a value domain, never narrow it.
// Complex members stay exact: implicit collection casts are not portable.
func hiveNativeTypeContains(source, target string) bool {
	want, err := hivesql.ParseType(source)
	if err != nil {
		return false
	}
	have, err := hivesql.ParseType(target)
	if err != nil {
		return false
	}
	if want.String() == have.String() {
		return true
	}
	integerRank := map[string]int{"tinyint": 1, "smallint": 2, "int": 3, "bigint": 4}
	if rank := integerRank[want.Kind]; rank > 0 && integerRank[have.Kind] >= rank {
		return true
	}
	if want.Kind == "decimal" && have.Kind == "decimal" {
		return have.Scale >= want.Scale && have.Precision-have.Scale >= want.Precision-want.Scale
	}
	if have.Kind == "string" && (want.Kind == "char" || want.Kind == "varchar") {
		return true
	}
	if have.Kind == "varchar" && (want.Kind == "char" || want.Kind == "varchar") {
		return have.Length >= want.Length
	}
	return want.Kind == "float" && have.Kind == "double"
}
