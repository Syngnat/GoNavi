package sqlaudit

import (
	"strings"
	"testing"
)

func TestRedactSQLRemovesDialectLiteralsCommentsAndCredentials(t *testing.T) {
	input := `-- comment-secret
SELECT 'alice-secret', 12345, $$postgres-secret$$, q'[oracle-secret]'
FROM users /* block-secret */
WHERE password = bare-secret
  AND endpoint = 'postgres://alice:db-secret@example.test/app'
  AND note = "quoted-secret"`

	redacted := RedactSQL(input)
	for _, secret := range []string{
		"comment-secret", "alice-secret", "12345", "postgres-secret", "oracle-secret",
		"block-secret", "bare-secret", "alice", "db-secret", "quoted-secret",
	} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("redacted SQL leaked %q: %s", secret, redacted)
		}
	}
	if !strings.Contains(redacted, "SELECT") || !strings.Contains(redacted, "FROM users") {
		t.Fatalf("redaction should retain SQL structure: %s", redacted)
	}
	if !strings.Contains(redacted, "password = ?") {
		t.Fatalf("sensitive unquoted assignment should be replaced: %s", redacted)
	}
}

func TestRedactSQLPreservesIdentifiersAndPlaceholders(t *testing.T) {
	input := "SELECT report_2026, `OrderID`, [AccountID] FROM events WHERE id = $1 AND name = ?"
	redacted := RedactSQL(input)
	for _, fragment := range []string{"report_2026", "`OrderID`", "[AccountID]", "$1", "name = ?"} {
		if !strings.Contains(redacted, fragment) {
			t.Fatalf("expected %q to remain in %q", fragment, redacted)
		}
	}
}

func TestRedactErrorRemovesSecretsAndControlCharacters(t *testing.T) {
	input := "connect postgres://alice:db-secret@example.test/app password=top-secret " +
		"Authorization: Bearer abc.def.ghi Basic dXNlcjpwYXNz fallback alice:bare-pass@db.internal oracle scott/tiger@dbhost/service near 'literal-secret'\nnext"
	redacted := RedactError(input)
	for _, secret := range []string{"alice", "db-secret", "top-secret", "abc.def.ghi", "dXNlcjpwYXNz", "bare-pass", "scott", "tiger", "service", "literal-secret"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("redacted error leaked %q: %s", secret, redacted)
		}
	}
	if strings.ContainsAny(redacted, "\r\n") {
		t.Fatalf("redacted error should be single line: %q", redacted)
	}
}

func TestRedactSQLRemovesNestedBlockComments(t *testing.T) {
	redacted := RedactSQL("SELECT 1 /* outer /* nested */ private-after-nested */ FROM users")
	if strings.Contains(redacted, "outer") || strings.Contains(redacted, "nested") || strings.Contains(redacted, "private-after-nested") {
		t.Fatalf("nested SQL comment leaked into audit text: %q", redacted)
	}
	if !strings.Contains(redacted, "FROM users") {
		t.Fatalf("nested comment redaction removed following SQL structure: %q", redacted)
	}
}

func TestRedactSQLPreservesSensitiveNamedColumnsWithoutAssignments(t *testing.T) {
	input := "SELECT password, token, secret FROM sessions"
	if redacted := RedactSQL(input); redacted != input {
		t.Fatalf("sensitive-named columns were mistaken for assigned values: %q", redacted)
	}
}

func TestRedactErrorRemovesUnquotedDuplicateKeyValues(t *testing.T) {
	input := "ERROR: duplicate key value violates unique constraint; DETAIL: Key (email, tenant_id)=(alice@example.test, 42) already exists; The duplicate key value is (private-token). Failing row contains (7, failing@example.test, row-secret)."
	redacted := RedactError(input)
	for _, secret := range []string{"alice@example.test", "42", "private-token", "failing@example.test", "row-secret"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("redacted duplicate-key error leaked %q: %s", secret, redacted)
		}
	}
	if !strings.Contains(redacted, "Key (email, tenant_id)=(?)") {
		t.Fatalf("redacted error lost safe constraint structure: %s", redacted)
	}
}

func TestRedactionBoundsStoredText(t *testing.T) {
	longSQL := "SELECT '" + strings.Repeat("界", maxSQLRunes+100) + "'"
	if got := len([]rune(RedactSQL(longSQL))); got > maxSQLRunes {
		t.Fatalf("redacted SQL exceeds limit: %d", got)
	}
	longError := strings.Repeat("failure ", maxErrorRunes)
	if got := len([]rune(RedactError(longError))); got > maxErrorRunes {
		t.Fatalf("redacted error exceeds limit: %d", got)
	}
}

func TestRedactQueryUsesSQLLexerForSQLTypes(t *testing.T) {
	query := "SELECT * FROM users WHERE password = 'sql-secret' AND id = 42"
	for _, dbType := range []string{"mysql", "postgres", "sqlserver", "oracle", "clickhouse", "custom", "cache", "Caché", "InterSystems Cache", "InterSystems Caché"} {
		if got, want := RedactQuery(dbType, query), RedactSQL(query); got != want {
			t.Fatalf("RedactQuery(%s)=%q, want SQL redaction %q", dbType, got, want)
		}
	}
}

func TestRedactQueryRedactsRedisValuesAndPreservesCommandsAndKeys(t *testing.T) {
	tests := []struct {
		name    string
		query   string
		want    string
		secrets []string
	}{
		{name: "auth", query: "AUTH default auth-secret", want: "AUTH ? ?", secrets: []string{"default", "auth-secret"}},
		{name: "hello auth", query: "HELLO 3 AUTH app hello-secret SETNAME client-secret", want: "HELLO 3 AUTH ? ? SETNAME ?", secrets: []string{"app", "hello-secret", "client-secret"}},
		{name: "config set", query: "CONFIG SET requirepass config-secret", want: "CONFIG SET requirepass ?", secrets: []string{"config-secret"}},
		{name: "set", query: "SET session:key set-secret EX 60", want: "SET session:key ?", secrets: []string{"set-secret", "60"}},
		{name: "mset", query: "MSET key:1 first-secret key:2 second-secret", want: "MSET key:1 ? key:2 ?", secrets: []string{"first-secret", "second-secret"}},
		{name: "hset", query: "HSET profile:1 email private@example.test token hash-secret", want: "HSET profile:1 email ? token ?", secrets: []string{"private@example.test", "hash-secret"}},
		{name: "list", query: "LPUSH queue:key payload-one payload-two", want: "LPUSH queue:key ?", secrets: []string{"payload-one", "payload-two"}},
		{name: "set member", query: "SADD set:key member-secret", want: "SADD set:key ?", secrets: []string{"member-secret"}},
		{name: "sorted set", query: "ZADD rank:key 12.5 member-secret", want: "ZADD rank:key ?", secrets: []string{"12.5", "member-secret"}},
		{name: "publish", query: "PUBLISH channel:key message-secret", want: "PUBLISH channel:key ?", secrets: []string{"message-secret"}},
		{name: "stream", query: "XADD stream:key * field payload-secret", want: "XADD stream:key ?", secrets: []string{"payload-secret", "field"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RedactQuery("redis", tt.query)
			if got != tt.want {
				t.Fatalf("RedactQuery(redis)=%q, want %q", got, tt.want)
			}
			for _, secret := range tt.secrets {
				if strings.Contains(got, secret) {
					t.Fatalf("Redis redaction leaked %q in %q", secret, got)
				}
			}
		})
	}
}

func TestRedactQueryDefaultsMessageAndUnknownLanguagesToMetadataOnly(t *testing.T) {
	query := `PUBLISH topic {"token":"message-secret"}`
	for _, dbType := range []string{"rocketmq", "mqtt", "kafka", "rabbitmq", "mongodb", "elasticsearch", "milvus", "mystery-driver"} {
		if got := RedactQuery(dbType, query); got != "" {
			t.Fatalf("RedactQuery(%s)=%q, want metadata-only empty text", dbType, got)
		}
	}
	if got := RedactQuery("redis", `SET key "unterminated-secret`); got != "" {
		t.Fatalf("unparseable Redis input must fall back to metadata-only, got %q", got)
	}
}

func TestSanitizeEventPreservesPendingCommitMode(t *testing.T) {
	event := sanitizeEvent(Event{
		EventType:  "transaction_begin",
		Status:     "success",
		CommitMode: CommitModePending,
	}, Settings{
		Enabled:       true,
		CaptureMode:   CaptureModeRedacted,
		RetentionDays: 30,
		MaxRecords:    100,
	})
	if event.CommitMode != CommitModePending {
		t.Fatalf("pending commit mode = %q, want %q", event.CommitMode, CommitModePending)
	}
}
