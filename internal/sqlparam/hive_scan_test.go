package sqlparam

import "testing"

func TestHiveScanUsesHiveNotMySQLCommentGrammar(t *testing.T) {
	for _, dbType := range []string{"hive", "hive2", "apache-hive", "apache_hive"} {
		t.Run(dbType, func(t *testing.T) {
			opts := OptionsForDBType(dbType)
			if !opts.BackslashEscapes || opts.HashComments || opts.DashCommentNeedsSpace || opts.DollarQuotes || opts.BracketIdentifiers {
				t.Fatalf("unexpected Hive lexical options: %+v", opts)
			}
		})
	}
}
