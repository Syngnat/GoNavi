package sqlaudit

import (
	"strings"
	"testing"
)

func TestHiveAuditRedactsNativeSQLValues(t *testing.T) {
	for _, dbType := range []string{"hive", "hive2", "apache-hive", "apache_hive"} {
		t.Run(dbType, func(t *testing.T) {
			query := "INSERT INTO events SELECT 'private-hive-value', array('sensitive-array-value'), 817263"
			redacted := RedactQuery(dbType, query)
			if redacted == "" || !strings.Contains(strings.ToUpper(redacted), "INSERT INTO") {
				t.Fatalf("Hive audit lost SQL structure: %q", redacted)
			}
			for _, secret := range []string{"private-hive-value", "sensitive-array-value", "817263"} {
				if strings.Contains(redacted, secret) {
					t.Fatalf("Hive audit exposed literal %q: %q", secret, redacted)
				}
			}
		})
	}
}
