package app

import (
	"reflect"
	"strings"
	"testing"
)

func TestStreamSQLFileDropsCommentOnlyTail(t *testing.T) {
	t.Parallel()

	var statements []string
	count, err := streamSQLFile(
		strings.NewReader("DELETE FROM users WHERE id = 1; -- keep this operation pending"),
		func(_ int, statement string) error {
			statements = append(statements, statement)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected one executable statement, got %d", count)
	}
	want := []string{"DELETE FROM users WHERE id = 1"}
	if !reflect.DeepEqual(statements, want) {
		t.Fatalf("expected statements %#v, got %#v", want, statements)
	}
}

func TestSQLStreamSplitterPreservesExecutableMySQLComment(t *testing.T) {
	t.Parallel()

	splitter := &sqlStreamSplitter{}
	got := splitter.Feed([]byte("/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;"))
	want := []string{"/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected statements %#v, got %#v", want, got)
	}
}

func TestSQLStreamSplitterTransactionBeginFormsAcrossChunkBoundaries(t *testing.T) {
	tests := []struct {
		dbType string
		begin  string
	}{
		{dbType: "sqlserver", begin: "BEGIN TRAN"},
		{dbType: "sqlserver", begin: "BEGIN DISTRIBUTED TRANSACTION"},
		{dbType: "sqlserver", begin: "BEGIN DIALOG CONVERSATION @handle"},
		{dbType: "sqlserver", begin: "BEGIN CONVERSATION TIMER (@handle) TIMEOUT = 30"},
		{dbType: "sqlite", begin: "BEGIN IMMEDIATE"},
		{dbType: "postgres", begin: "BEGIN NOT DEFERRABLE"},
	}

	for _, test := range tests {
		t.Run(test.dbType+" "+test.begin, func(t *testing.T) {
			input := test.begin + "; UPDATE demo SET value = 2; COMMIT;"
			splitter := &sqlStreamSplitter{dbType: test.dbType}
			var got []string
			for index := range len(input) {
				got = append(got, splitter.Feed([]byte(input[index:index+1]))...)
			}
			if last := splitter.Flush(); last != "" {
				got = append(got, last)
			}
			want := []string{test.begin, "UPDATE demo SET value = 2", "COMMIT"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("one-byte streaming split of %q = %#v, want %#v", input, got, want)
			}
		})
	}
}

func TestSQLStreamSplitterKeepsSQLServerBracketIdentifiersAcrossChunkBoundaries(t *testing.T) {
	input := "SELECT * FROM [audit]];events]; SELECT 2;"
	splitter := &sqlStreamSplitter{dbType: "sqlserver"}
	var got []string
	for index := range len(input) {
		got = append(got, splitter.Feed([]byte(input[index:index+1]))...)
	}
	if last := splitter.Flush(); last != "" {
		got = append(got, last)
	}
	want := []string{"SELECT * FROM [audit]];events]", "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("one-byte streaming split of %q = %#v, want %#v", input, got, want)
	}
}

func TestSQLStreamSplitterKeepsSQLiteBracketIdentifiersAcrossChunkBoundaries(t *testing.T) {
	input := "SELECT * FROM [a;b]; SELECT 2;"
	splitter := &sqlStreamSplitter{dbType: "sqlite"}
	var got []string
	for index := range len(input) {
		got = append(got, splitter.Feed([]byte(input[index:index+1]))...)
	}
	if last := splitter.Flush(); last != "" {
		got = append(got, last)
	}
	want := []string{"SELECT * FROM [a;b]", "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("one-byte streaming split of %q = %#v, want %#v", input, got, want)
	}
}

func TestSQLStreamSplitterKeepsMariaDBNotAtomicBlockAcrossChunkBoundaries(t *testing.T) {
	block := "BEGIN NOT ATOMIC\n  SET @value = 1;\nEND"
	input := block + "; SELECT 1;"
	splitter := &sqlStreamSplitter{dbType: "mariadb"}
	var got []string
	for index := range len(input) {
		got = append(got, splitter.Feed([]byte(input[index:index+1]))...)
	}
	if last := splitter.Flush(); last != "" {
		got = append(got, last)
	}
	want := []string{block + ";", "SELECT 1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("one-byte streaming split of %q = %#v, want %#v", input, got, want)
	}
}

func TestSQLStreamSplitterUsesDialectForAmbiguousBeginTran(t *testing.T) {
	input := "BEGIN\n  TRAN;\nEND;\nSELECT 1 FROM dual;"
	splitter := &sqlStreamSplitter{dbType: "oracle"}
	var got []string
	for index := range len(input) {
		got = append(got, splitter.Feed([]byte(input[index:index+1]))...)
	}
	if last := splitter.Flush(); last != "" {
		got = append(got, last)
	}
	want := []string{"BEGIN\n  TRAN;\nEND;", "SELECT 1 FROM dual"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("one-byte Oracle BEGIN TRAN procedure block = %#v, want %#v", got, want)
	}
}
