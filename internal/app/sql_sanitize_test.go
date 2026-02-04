package app

import "testing"

func TestSanitizeSQLForPgLike_FixesBrokenDoubleDoubleQuotes(t *testing.T) {
	in := `SELECT * FROM ""ldf_server"".""t_user"" LIMIT 1`
	out := sanitizeSQLForPgLike("kingbase", in)
	want := `SELECT * FROM "ldf_server"."t_user" LIMIT 1`
	if out != want {
		t.Fatalf("unexpected sanitize output:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_FixesBrokenDoubleDoubleQuotes_WithExtraQuotes(t *testing.T) {
	in := `SELECT * FROM ""ldf_server""".""t_user"" LIMIT 1`
	out := sanitizeSQLForPgLike("kingbase", in)
	want := `SELECT * FROM "ldf_server"."t_user" LIMIT 1`
	if out != want {
		t.Fatalf("unexpected sanitize output:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_FixesBrokenDoubleDoubleQuotes_WithQuadQuotes(t *testing.T) {
	in := `SELECT * FROM """"ldf_server"""".""t_user"" LIMIT 1`
	out := sanitizeSQLForPgLike("kingbase", in)
	want := `SELECT * FROM "ldf_server"."t_user" LIMIT 1`
	if out != want {
		t.Fatalf("unexpected sanitize output:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_DoesNotTouchEscapedQuotesInsideIdentifier(t *testing.T) {
	in := `SELECT "a""b" FROM "t""x"`
	out := sanitizeSQLForPgLike("postgres", in)
	if out != in {
		t.Fatalf("should keep valid escaped quotes inside identifier:\nIN:  %s\nOUT: %s", in, out)
	}
}

func TestSanitizeSQLForPgLike_DoesNotTouchDollarQuotedStrings(t *testing.T) {
	in := "SELECT $$\"\"ldf_server\"\"$$, \"\"ldf_server\"\""
	out := sanitizeSQLForPgLike("postgres", in)
	want := "SELECT $$\"\"ldf_server\"\"$$, \"ldf_server\""
	if out != want {
		t.Fatalf("unexpected sanitize output for dollar quoted string:\nIN:   %s\nOUT:  %s\nWANT: %s", in, out, want)
	}
}

func TestSanitizeSQLForPgLike_DoesNotModifyOtherDBTypes(t *testing.T) {
	in := `SELECT * FROM ""ldf_server""`
	out := sanitizeSQLForPgLike("mysql", in)
	if out != in {
		t.Fatalf("non-PG-like db should not be sanitized:\nIN:  %s\nOUT: %s", in, out)
	}
}
