package app

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeSQLFileFastBatchDB struct {
	*fakeSQLFileBatchDB
}

func (f *fakeSQLFileFastBatchDB) SupportsBatchWrites() bool { return true }

func fastSQLFileText(key string, _ map[string]any) string { return key }

func TestExecuteSQLFileFastCreateBatchUsesOneRoundTrip(t *testing.T) {
	fakeDB := &fakeSQLFileFastBatchDB{fakeSQLFileBatchDB: &fakeSQLFileBatchDB{}}
	input := strings.Join([]string{
		"CREATE TABLE t1 (id INT)",
		"CREATE TABLE t2 (id INT)",
		"CREATE TABLE t3 (id INT)",
		"CREATE TABLE t4 (id INT)",
		"CREATE TABLE t5 (id INT)",
		"CREATE TABLE t6 (id INT)",
		"CREATE TABLE t7 (id INT)",
		"CREATE TABLE t8 (id INT)",
		"CREATE TABLE t9 (id INT)",
		"CREATE TABLE t10 (id INT)",
		"CREATE TABLE t11 (id INT)",
		"CREATE TABLE t12 (id INT)",
		"CREATE TABLE t13 (id INT)",
		"CREATE TABLE t14 (id INT)",
		"CREATE TABLE t15 (id INT)",
	}, ";\n") + ";"

	var progress []sqlFileExecutionProgress
	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		BatchCreateOnly: true,
		Text:            fastSQLFileText,
		OnProgress:      func(event sqlFileExecutionProgress) { progress = append(progress, event) },
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Executed != 15 || result.Failed != 0 {
		t.Fatalf("result = %+v", result)
	}
	if fakeDB.batchCalls != 1 || fakeDB.execCalls != 0 {
		t.Fatalf("batchCalls=%d execCalls=%d", fakeDB.batchCalls, fakeDB.execCalls)
	}
	if len(fakeDB.batchQueries) != 1 || !strings.Contains(fakeDB.batchQueries[0], "CREATE TABLE t15") {
		t.Fatalf("batch query = %#v", fakeDB.batchQueries)
	}
	if len(progress) != 1 || progress[0].Executed != 15 {
		t.Fatalf("progress = %#v", progress)
	}
}

func TestExecuteSQLFileFastCreateBatchFallsBackForNonCreate(t *testing.T) {
	fakeDB := &fakeSQLFileFastBatchDB{fakeSQLFileBatchDB: &fakeSQLFileBatchDB{}}
	input := "CREATE TABLE t1 (id INT);\nINSERT INTO t1 (id) VALUES (1);"
	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		BatchCreateOnly: true,
		Text:            fastSQLFileText,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Executed != 2 || fakeDB.execCalls != 2 || fakeDB.batchCalls != 0 {
		t.Fatalf("result=%+v execCalls=%d batchCalls=%d", result, fakeDB.execCalls, fakeDB.batchCalls)
	}
}

func TestExecuteSQLFileFastCreateBatchRequiresExplicitBatchCapability(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := "CREATE TABLE t1 (id INT);\nCREATE TABLE t2 (id INT);"
	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		BatchCreateOnly: true,
		Text:            fastSQLFileText,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Executed != 2 || fakeDB.execCalls != 2 || fakeDB.batchCalls != 0 {
		t.Fatalf("result=%+v execCalls=%d batchCalls=%d", result, fakeDB.execCalls, fakeDB.batchCalls)
	}
}

func TestExecuteSQLFileFastCreateBatchMarksPartialBatchUnknown(t *testing.T) {
	fakeDB := &fakeSQLFileFastBatchDB{fakeSQLFileBatchDB: &fakeSQLFileBatchDB{
		failBatch:  true,
		batchError: errors.New("table already exists"),
	}}
	input := "CREATE TABLE t1 (id INT);\nCREATE TABLE t2 (id INT);"
	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		BatchCreateOnly: true,
		Text:            fastSQLFileText,
	}, nil)
	if err == nil || !result.OutcomeUnknown || result.Failed != 1 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if fakeDB.batchCalls != 1 || fakeDB.execCalls != 0 {
		t.Fatalf("batchCalls=%d execCalls=%d", fakeDB.batchCalls, fakeDB.execCalls)
	}
}
