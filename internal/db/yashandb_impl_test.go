//go:build gonavi_full_drivers || gonavi_yashandb_driver

package db

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestYashanSchemaIdentifierQuotesOnlyMixedOrSpecialNames(t *testing.T) {
	cases := map[string]string{
		"GONAVI":    "GONAVI",
		"gonavi":    "gonavi",
		"APP_1$":    "APP_1$",
		"MixedCase": `"MixedCase"`,
		"has space": `"has space"`,
		`quo"te`:    `"quo""te"`,
		"1ABC":      `"1ABC"`,
	}
	for schema, want := range cases {
		if got := yashanSchemaIdentifier(schema); got != want {
			t.Errorf("yashanSchemaIdentifier(%q) = %s, want %s", schema, got, want)
		}
	}
}

func TestYacliTimestampBytesEncodesWallClockMicros(t *testing.T) {
	local := time.Date(2024, 2, 29, 13, 14, 15, 123456789, time.FixedZone("+08:00", 8*3600))
	buffer := yacliTimestampBytes(local)
	if len(buffer) != 12 {
		t.Fatalf("len = %d", len(buffer))
	}
	stamp := int64(binary.LittleEndian.Uint64(buffer[:8]))
	if want := time.Date(2024, 2, 29, 13, 14, 15, 123456000, time.UTC).UnixMicro(); stamp != want {
		t.Fatalf("stamp = %d, want %d", stamp, want)
	}
	if bias := binary.LittleEndian.Uint16(buffer[8:10]); bias != 0 {
		t.Fatalf("bias = %d", bias)
	}
}

func TestYashanZoneName(t *testing.T) {
	for bias, want := range map[int]string{0: "+00:00", 330: "+05:30", -90: "-01:30", 480: "+08:00"} {
		if got := yashanZoneName(bias); got != want {
			t.Errorf("yashanZoneName(%d) = %s, want %s", bias, got, want)
		}
	}
}

func TestYacliTextBufferSize(t *testing.T) {
	if got := yacliTextBufferSize(&yacliColumn{typ: yacTypeVarchar, size: 100}); got != 401 {
		t.Fatalf("varchar buffer %d", got)
	}
	if got := yacliTextBufferSize(&yacliColumn{typ: yacTypeNumber, size: 20}); got != 160 {
		t.Fatalf("number buffer %d", got)
	}
	if got := yacliTextBufferSize(&yacliColumn{typ: yacTypeVector}); got != yacliDefaultTextBuffer {
		t.Fatalf("vector buffer %d", got)
	}
}

func TestResolveYashanClientLibrary(t *testing.T) {
	home := t.TempDir()
	candidate := yashanClientLibraryCandidates()[0]
	if err := os.MkdirAll(filepath.Join(home, filepath.Dir(candidate)), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveYashanClientLibrary(home, ""); err == nil || !strings.Contains(err.Error(), home) {
		t.Fatalf("missing library error = %v", err)
	}
	library := filepath.Join(home, candidate)
	if err := os.WriteFile(library, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := resolveYashanClientLibrary(home, ""); err != nil || got != library {
		t.Fatalf("resolved %q, %v", got, err)
	}
	if got, _ := resolveYashanClientLibrary(home, "custom/yacli.so"); got != filepath.Join(home, "custom", "yacli.so") {
		t.Fatalf("relative override %q", got)
	}
	t.Setenv("YASDB_HOME", home)
	if got, err := resolveYashanClientLibrary("", ""); err != nil || got != library {
		t.Fatalf("YASDB_HOME resolution %q, %v", got, err)
	}
}

func TestYashanPreloadLibrariesOrdersOpenSSLBeforeInfra(t *testing.T) {
	if runtime.GOOS == "windows" {
		if yashanPreloadLibraries(t.TempDir()) != nil {
			t.Fatal("windows resolves dependencies through LoadLibraryEx")
		}
		return
	}
	dir := t.TempDir()
	suffix := ".so"
	if runtime.GOOS == "darwin" {
		suffix = ".dylib"
	}
	for _, name := range []string{"libyas_infra" + suffix + ".0", "libssl" + suffix + ".1.1", "libcrypto" + suffix + ".1.1", "libyascli" + suffix, "libcurl" + suffix} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var names []string
	for _, path := range yashanPreloadLibraries(dir) {
		names = append(names, filepath.Base(path))
	}
	want := []string{"libcrypto" + suffix + ".1.1", "libssl" + suffix + ".1.1", "libyas_infra" + suffix + ".0"}
	if !slices.Equal(names, want) {
		t.Fatalf("preload order %v, want %v", names, want)
	}
}

func TestYashanVersionPattern(t *testing.T) {
	for banner, want := range map[string]string{
		"Enterprise Edition Release 23.4.7.100 x86_64": "23.4.7.100",
		"Personal Edition Release 23.1.1.100 x86_64":   "23.1.1.100",
		"YashanDB Server 22.2.12":                      "22.2.12",
	} {
		if got := yashanVersionPattern.FindString(banner); got != want {
			t.Errorf("version(%q) = %q, want %q", banner, got, want)
		}
	}
}

func TestYacliErrorMessageIncludesPosition(t *testing.T) {
	err := &yacliError{Code: 4209, Message: "unexpected word WITH", Line: 8, Column: 21}
	if got := err.Error(); got != "YAS-04209 unexpected word WITH [8:21]" {
		t.Fatalf("error text %q", got)
	}
	if got := (&yacliError{Code: 2213, Message: "insufficient privileges"}).Error(); got != "YAS-02213 insufficient privileges" {
		t.Fatalf("error text %q", got)
	}
}

func TestYashanTriggerEnablePatternKeepsDefinitionEnd(t *testing.T) {
	ddl := "CREATE OR REPLACE TRIGGER " + `"A"."T"` + " BEFORE UPDATE ON t FOR EACH ROW BEGIN NULL; END;\nALTER TRIGGER " + `"A"."T"` + " ENABLE"
	got := strings.TrimSpace(yashanTriggerEnablePattern.ReplaceAllString(ddl, ""))
	if want := "CREATE OR REPLACE TRIGGER " + `"A"."T"` + " BEFORE UPDATE ON t FOR EACH ROW BEGIN NULL; END;"; got != want {
		t.Fatalf("stripped trigger = %q, want %q", got, want)
	}
	if body := "BEGIN NULL; END;"; yashanTriggerEnablePattern.ReplaceAllString(body, "") != body {
		t.Fatal("definitions without the ENABLE suffix must stay unchanged")
	}
}
