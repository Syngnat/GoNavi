package hivesql

import "testing"

func TestHiveVerifiedNotNullAndPartitions(t *testing.T) {
	ddl := "CREATE TABLE t (id INT, required STRING, fake STRING COMMENT 'NOT NULL'); ALTER TABLE " + QuoteIdentifier("db") + "." + QuoteIdentifier("t") + " CHANGE COLUMN " + QuoteIdentifier("required") + " " + QuoteIdentifier("required") + " STRING CONSTRAINT " + QuoteIdentifier("nn") + " NOT NULL ENABLE NOVALIDATE RELY;"
	got, err := ValidateNotNullMetadata([]string{"required"}, ddl)
	if err != nil || !got["required"] || got["fake"] || got["id"] {
		t.Fatalf("NOTNULL metadata=%v err=%v", got, err)
	}
	disabled := "CREATE TABLE t (optional STRING NOT NULL DISABLE NOVALIDATE, id INT, PRIMARY KEY(id) DISABLE NOVALIDATE)"
	got, err = EnforcedNotNullColumns(disabled)
	if err != nil || len(got) != 0 {
		t.Fatalf("disabled/PK constraints fabricated NOTNULL: %v %v", got, err)
	}
	if _, err = ValidateNotNullMetadata([]string{"required"}, "CREATE TABLE t(required STRING)"); err == nil {
		t.Fatal("unverified constraint silently called nullable")
	}
	partitions, err := PartitionColumnsFromDDL("CREATE TABLE t(id INT) PARTITIONED BY (year INT COMMENT 'x,y', month STRING) STORED AS PARQUET")
	if err != nil || len(partitions) != 2 || partitions[0] != "year" || partitions[1] != "month" {
		t.Fatalf("partitions=%v err=%v", partitions, err)
	}
}
