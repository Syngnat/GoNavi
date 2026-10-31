package sync

import (
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// hiveServerSupportsManagedTableDDL reports whether the connected server accepts
// Hive 4's CREATE MANAGED TABLE form. Hive 4 turns plain CREATE TABLE into an
// external table by default (hive.create.as.external.legacy), which cannot be
// truncated; naming the managed form keeps auto-created sync targets writable
// with the same overwrite semantics users get on Hive 2/3.
//
// Spark and Impala expose 4.x server versions too, but only Apache Hive has this
// DDL keyword, so the family must be proven first. Using the version alone would
// send unsupported syntax to a Spark 4 / Impala 4 target.
func hiveServerSupportsManagedTableDDL(config connection.ConnectionConfig, database db.Database) bool {
	if family, err := db.HiveConnectionFamily(config); err != nil || family != "hive" {
		return false
	}
	reporter, ok := database.(db.DriverVariantReporter)
	if !ok {
		return false
	}
	_, version := reporter.DriverVariantInfo()
	return hiveMajorVersion(version) >= 4
}

// hiveMajorVersion extracts the leading major version from a server banner or a
// bare version string such as "4.0.1" or "Hive 3.1.3".
func hiveMajorVersion(version string) int {
	for _, token := range strings.FieldsFunc(version, func(r rune) bool {
		return r == '.' || r == ' ' || r == '-' || r == '_' || r == '+'
	}) {
		if major, err := strconv.Atoi(strings.TrimSpace(token)); err == nil {
			return major
		}
	}
	return 0
}
