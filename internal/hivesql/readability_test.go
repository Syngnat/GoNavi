package hivesql

import "testing"

func TestHiveNestedBinaryReadability(t *testing.T) {
	for _, typeName := range []string{"BINARY", "ARRAY<STRING>", "MAP<STRING,DECIMAL(38,4)>", "STRUCT<n:INT>"} {
		if err := ValidateReadableType(typeName); err != nil {
			t.Fatalf("readable type %s: %v", typeName, err)
		}
	}
	for _, typeName := range []string{"MAP<STRING,BINARY>", "ARRAY<STRUCT<p:BINARY>>", "STRUCT<n:UNIONTYPE<INT,BINARY>>"} {
		if err := ValidateReadableType(typeName); err == nil {
			t.Fatalf("lossy HS2 type accepted %s", typeName)
		}
	}
	// Writing typed source bytes is still supported; the read limitation must not
	// silently coerce those bytes or pretend the server display is reversible.
	literal, err := Value("MAP<STRING,BINARY>", map[string]any{"bytes": []byte{0, 255}})
	if err != nil || literal == "" {
		t.Fatalf("typed binary constructor=%q %v", literal, err)
	}
}
