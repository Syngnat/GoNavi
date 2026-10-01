package dbuser

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseDottedVersion(t *testing.T) {
	tests := []struct {
		name   string
		text   string
		marker string
		want   [3]int
	}{
		{name: "mysql8", text: "8.0.36-0ubuntu0.22.04.1", want: [3]int{8, 0, 36}},
		{name: "mysql57 log", text: "5.7.44-log", want: [3]int{5, 7, 44}},
		{name: "mariadb with replication prefix", text: "5.5.5-10.11.6-MariaDB-log", marker: "5.5.5-", want: [3]int{10, 11, 6}},
		{name: "postgres banner", text: "PostgreSQL 16.2 on x86_64-pc-linux-gnu", marker: "PostgreSQL", want: [3]int{16, 2, 0}},
		{name: "oceanbase", text: "5.7.25-OceanBase_CE-v4.2.1.2", marker: "-v", want: [3]int{4, 2, 1}},
		{name: "two part", text: "ClickHouse 24.3", want: [3]int{24, 3, 0}},
		{name: "unknown", text: "unknown", want: [3]int{0, 0, 0}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got Version
			if tt.marker != "" {
				got = ParseDottedVersionAfter(tt.text, tt.marker)
			} else {
				got = ParseDottedVersion(tt.text)
			}
			if [3]int{got.Major, got.Minor, got.Patch} != tt.want {
				t.Fatalf("got %d.%d.%d want %v", got.Major, got.Minor, got.Patch, tt.want)
			}
		})
	}
}

func TestVersionAtLeast(t *testing.T) {
	v := Version{Major: 8, Minor: 0, Patch: 19}
	cases := []struct {
		major, minor, patch int
		want                bool
	}{
		{8, 0, 19, true}, {8, 0, 20, false}, {5, 7, 6, true}, {8, 4, 0, false}, {9, 0, 0, false},
	}
	for _, c := range cases {
		if got := v.AtLeast(c.major, c.minor, c.patch); got != c.want {
			t.Fatalf("AtLeast(%d,%d,%d)=%v want %v", c.major, c.minor, c.patch, got, c.want)
		}
	}
	if (Version{}).AtLeast(0, 0, 1) {
		t.Fatal("unknown version must never satisfy AtLeast")
	}
}

func TestQuotingEscapesInjectionPayloads(t *testing.T) {
	payload := "a'b\\c`d\"e]f"
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"backtick", QuoteBacktick("x`; DROP"), "`x``; DROP`"},
		{"mysql account", MySQLAccount("u`", "%"), "`u```@`%`"},
		{"mysql string escapes backslash", MySQLString(payload, true), `'a''b\\c` + "`" + `d"e]f'`},
		{"mysql string no backslash escapes", MySQLString(payload, false), `'a''b\c` + "`" + `d"e]f'`},
		{"double quote", QuoteDouble(`r"x`), `"r""x"`},
		{"pg string", PGString(payload), `E'a''b\\c` + "`" + `d"e]f'`},
		{"bracket", QuoteBracket("a]b"), "[a]]b]"},
		{"nstring", NString("it's"), "N'it''s'"},
		{"clickhouse ident", QuoteClickHouseIdent("a`b\\"), "`a\\`b\\\\`"},
		{"clickhouse string", ClickHouseString("a'b\\"), `'a\'b\\'`},
		{"plain string", PlainString("a'b\\"), `'a''b\'`},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Fatalf("%s: got %s want %s", c.name, c.got, c.want)
		}
	}
}

func TestSQLBuilderMasksSecrets(t *testing.T) {
	var builder SQLBuilder
	builder.Write("CREATE USER ", MySQLAccount("app", "%"), " IDENTIFIED BY ").
		Secret(MySQLString("s3cr'et", true), Masked("'", "'"))
	statement := builder.Statement("", RiskNormal)
	if !strings.Contains(statement.Exec, "s3cr''et") {
		t.Fatalf("exec must contain escaped password: %s", statement.Exec)
	}
	if strings.Contains(statement.Display, "s3cr") || !strings.Contains(statement.Display, "'******'") {
		t.Fatalf("display must be masked: %s", statement.Display)
	}
	raw, err := json.Marshal(statement)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "s3cr") {
		t.Fatalf("serialized statement leaks password: %s", raw)
	}
}

func TestValidateName(t *testing.T) {
	if err := ValidateName("app_user", NameRule{MaxLength: 32}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := ValidateName("", NameRule{}); err == nil {
		t.Fatal("empty name must fail")
	}
	if err := ValidateName("a\x00b", NameRule{}); err == nil {
		t.Fatal("NUL must fail")
	}
	err := ValidateName(strings.Repeat("x", 33), NameRule{MaxLength: 32})
	if domainErr, ok := AsError(err); !ok || domainErr.Code != ErrCodeNameTooLong {
		t.Fatalf("want name_too_long, got %v", err)
	}
	if err := ValidateName("中文名", NameRule{MaxLength: 8, MaxBytes: true}); err == nil {
		t.Fatal("byte length must count UTF-8 bytes")
	}
	if err := ValidateName("a-b", NameRule{AllowedRunes: IsIdentifierRune}); err == nil {
		t.Fatal("whitelist must reject '-'")
	}
}

func TestValidatePasswordPolicy(t *testing.T) {
	policy := PasswordPolicy{MinLength: 8, MinCategories: 3, DisallowUsername: true, ForbiddenChars: "'"}
	cases := []struct {
		name     string
		password string
		rule     string
		ok       bool
	}{
		{"strong", "Abcdef1!", "", true},
		{"too short", "Ab1!", "min_length", false},
		{"two categories", "abcdefgh1", "categories", false},
		{"forbidden char", "Abcdef1'", "", false},
		{"reverse username", "Nimda1!x", "", true},
		{"newline", "Abc\ndef1!", "", false},
	}
	for _, c := range cases {
		err := ValidatePassword(c.password, "admin", policy)
		if c.ok && err != nil {
			t.Fatalf("%s: unexpected %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Fatalf("%s: expected error", c.name)
		}
		if c.rule != "" {
			domainErr, _ := AsError(err)
			if domainErr == nil || domainErr.Params["rule"] != c.rule {
				t.Fatalf("%s: want rule %s got %v", c.name, c.rule, err)
			}
		}
	}
	if err := ValidatePassword("nimda", "admin", PasswordPolicy{DisallowUsername: true}); err == nil {
		t.Fatal("reversed username must be rejected")
	}
}

func TestCellHelpersNormalizeDriverValues(t *testing.T) {
	row := map[string]any{"ACCOUNT_STATUS": []byte("LOCKED"), "limit": float64(10), "flag": "Y", "n": json.Number("3")}
	if CellString(row, "account_status") != "LOCKED" {
		t.Fatal("case-insensitive lookup failed")
	}
	if value, ok := CellInt(row, "limit"); !ok || value != 10 {
		t.Fatalf("float64 int failed: %v %v", value, ok)
	}
	if value, ok := CellInt(row, "n"); !ok || value != 3 {
		t.Fatal("json.Number failed")
	}
	if !CellBool(row, "flag") || CellBool(row, "missing") {
		t.Fatal("bool normalization failed")
	}
	if AsString(float64(8)) != "8" {
		t.Fatalf("float formatting: %s", AsString(float64(8)))
	}
}

func TestSanitizeErrorDoesNotWrapOrLeak(t *testing.T) {
	var secrets Secrets
	secrets.Add(`p@ss'w\rd`)
	original := &leakyError{text: `You have an error near 'IDENTIFIED BY 'p@ss''w\\rd'' at line 1`}
	sanitized := SanitizeError(original, &secrets)
	if strings.Contains(sanitized.Error(), "p@ss") {
		t.Fatalf("sanitized error leaks: %s", sanitized.Error())
	}
	var target *leakyError
	if asLeaky(sanitized, &target) {
		t.Fatal("sanitized error must not wrap the original")
	}
	domain := NewError(ErrCodeNameTooLong, nil)
	if SanitizeError(domain, &secrets) != error(domain) {
		t.Fatal("domain errors must pass through")
	}
}

type leakyError struct{ text string }

func (e *leakyError) Error() string { return e.text }

func asLeaky(err error, target **leakyError) bool {
	for err != nil {
		if leaky, ok := err.(*leakyError); ok {
			*target = leaky
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

func TestContractCoversDescriptorHelpers(t *testing.T) {
	descriptors := []OptionDescriptor{
		BoolOption(OptAccountLocked, TabGeneral),
		IntOption(OptConnectionLimit, TabAdvanced, -1, 0),
		EnumOption(OptAuthPlugin, TabGeneral, Choices("mysql_native_password")),
	}
	if err := CheckDescriptorsAgainstContract(descriptors); err != nil {
		t.Fatal(err)
	}
	if err := CheckDescriptorsAgainstContract([]OptionDescriptor{{ID: "nope", Type: OptionBool}}); err == nil {
		t.Fatal("unknown option must fail")
	}
	if err := CheckDescriptorsAgainstContract([]OptionDescriptor{{ID: OptAccountLocked, Type: OptionString}}); err == nil {
		t.Fatal("type mismatch must fail")
	}
}

func TestValidateRequestShape(t *testing.T) {
	profile := ServerProfile{
		Supported: true,
		Kinds:     []KindDescriptor{{Kind: KindUser, Creatable: true}},
		Options: []OptionDescriptor{
			BoolOption(OptAccountLocked, TabGeneral),
			{ID: OptAuthPlugin, Type: OptionEnum, Choices: Choices("a"), CreateOnly: true},
		},
	}
	base := ChangeRequest{Action: ActionAlter, Target: PrincipalRef{Kind: KindUser, Name: "u"}}
	if err := ValidateRequestShape(profile, base); err != nil {
		t.Fatal(err)
	}
	withUnknown := base
	withUnknown.Options = map[string]string{"evil": "1"}
	if err := ValidateRequestShape(profile, withUnknown); err == nil {
		t.Fatal("unknown option must fail")
	}
	createOnly := base
	createOnly.Options = map[string]string{OptAuthPlugin: "a"}
	if err := ValidateRequestShape(profile, createOnly); err == nil {
		t.Fatal("create-only option on alter must fail")
	}
	badBool := base
	badBool.Options = map[string]string{OptAccountLocked: "yes"}
	if err := ValidateRequestShape(profile, badBool); err == nil {
		t.Fatal("non-canonical bool must fail")
	}
	readOnly := profile
	readOnly.ReadOnly = true
	if err := ValidateRequestShape(readOnly, base); err == nil {
		t.Fatal("read-only profile must reject writes")
	}
	role := base
	role.Target.Kind = KindRole
	if err := ValidateRequestShape(profile, role); err == nil {
		t.Fatal("unsupported kind must fail")
	}
}
