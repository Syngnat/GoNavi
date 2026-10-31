package sync

import "testing"

func TestHiveExistingTargetCanWidenButNeverNarrowTypes(t *testing.T) {
	for _, test := range []struct {
		source, target string
		compatible     bool
	}{
		{"int", "bigint", true}, {"bigint", "int", false}, {"float", "double", true}, {"double", "float", false},
		{"decimal(10,2)", "decimal(20,5)", true}, {"decimal(10,2)", "decimal(10,5)", false}, {"decimal(38,18)", "decimal(38,17)", false},
		{"varchar(32)", "string", true}, {"char(32)", "varchar(64)", true}, {"string", "varchar(65535)", false}, {"varchar(64)", "char(64)", false},
		{"array<int>", "array<bigint>", false}, {"map<string,int>", "map<string,string>", false}, {"binary", "string", false},
	} {
		t.Run(test.source+" to "+test.target, func(t *testing.T) {
			if got := hiveNativeTypeContains(test.source, test.target); got != test.compatible {
				t.Fatalf("compatibility = %t; want %t", got, test.compatible)
			}
		})
	}
}
