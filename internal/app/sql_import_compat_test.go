package app

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestStreamSQLFileWithOptionsRejectsOversizedStatementWithPosition(t *testing.T) {
	var statements []string
	_, err := StreamSQLFileWithOptions(
		strings.NewReader("A;ABCDEFGHIJK;"),
		SQLStreamOptions{DBType: "postgres", MaxStatementBytes: 4},
		func(_ int, statement string) error {
			statements = append(statements, statement)
			return nil
		},
	)
	var limitErr *SQLStatementTooLargeError
	if !errors.As(err, &limitErr) {
		t.Fatalf("stream error = %v, want SQLStatementTooLargeError", err)
	}
	if limitErr.StatementIndex != 1 || limitErr.SourceByte != 7 || limitErr.MaxBytes != 4 {
		t.Fatalf("limit error = %#v, want statement 1 at source byte 7", limitErr)
	}
	if !reflect.DeepEqual(statements, []string{"A"}) {
		t.Fatalf("statements before limit = %#v, want first completed statement", statements)
	}
}

func TestStreamSQLFileForDialectUsesMySQLDashCommentRule(t *testing.T) {
	var statements []string
	_, err := streamSQLFileForDialect(strings.NewReader("SELECT 3--2;\nSELECT 4;"), "mysql", func(_ int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("stream SQL file: %v", err)
	}

	want := []string{"SELECT 3--2", "SELECT 4"}
	if !reflect.DeepEqual(statements, want) {
		t.Fatalf("statements = %#v, want %#v", statements, want)
	}
}

func TestStreamSQLFileForDialectConsumesMySQLDelimiterDirectives(t *testing.T) {
	input := strings.Join([]string{
		"DELIMITER $$",
		"CREATE PROCEDURE rebuild_demo()",
		"BEGIN",
		"  INSERT INTO demo(id) VALUES (1);",
		"  INSERT INTO demo(id) VALUES (2);",
		"END$$",
		"DELIMITER ;",
		"INSERT INTO demo(id) VALUES (3);",
	}, "\n")

	var statements []string
	_, err := streamSQLFileForDialect(strings.NewReader(input), "mysql", func(_ int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("stream SQL file: %v", err)
	}

	want := []string{
		"CREATE PROCEDURE rebuild_demo()\nBEGIN\n  INSERT INTO demo(id) VALUES (1);\n  INSERT INTO demo(id) VALUES (2);\nEND",
		"INSERT INTO demo(id) VALUES (3)",
	}
	if !reflect.DeepEqual(statements, want) {
		t.Fatalf("statements = %#v, want %#v", statements, want)
	}
}

func TestStreamSQLFileForDialectConsumesMySQLDelimiterAfterHeaderComment(t *testing.T) {
	input := "-- generated dump\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\n"

	var statements []string
	_, err := streamSQLFileForDialect(strings.NewReader(input), "mysql", func(_ int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("stream SQL file: %v", err)
	}

	want := []string{"CREATE PROCEDURE p() BEGIN SELECT 1; END"}
	if !reflect.DeepEqual(statements, want) {
		t.Fatalf("statements = %#v, want delimiter directive after header comment %#v", statements, want)
	}
}

func TestStreamSQLFileForDialectConsumesSQLServerGoBatches(t *testing.T) {
	input := strings.Join([]string{
		"CREATE TABLE demo(id int)",
		"GO",
		"INSERT INTO demo(id) VALUES (1);",
		"GO 2",
	}, "\n")

	var statements []string
	_, err := streamSQLFileForDialect(strings.NewReader(input), "sqlserver", func(_ int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("stream SQL file: %v", err)
	}

	want := []string{
		"CREATE TABLE demo(id int)",
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (1);",
	}
	if !reflect.DeepEqual(statements, want) {
		t.Fatalf("statements = %#v, want %#v", statements, want)
	}
}

func TestStreamSQLFileForDialectKeepsSQLServerBatchScope(t *testing.T) {
	input := "DECLARE @value int = 1;\nSELECT @value;\nGO\n"

	var statements []string
	_, err := streamSQLFileForDialect(strings.NewReader(input), "sqlserver", func(_ int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("stream SQL file: %v", err)
	}

	want := []string{"DECLARE @value int = 1;\nSELECT @value;"}
	if !reflect.DeepEqual(statements, want) {
		t.Fatalf("statements = %#v, want one SQL Server batch %#v", statements, want)
	}
}
