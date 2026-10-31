package app

import (
	"net/url"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveJDBCURIAndParameterSecretsStayOutOfSavedMetadata(t *testing.T) {
	config := connection.ConnectionConfig{
		Type: "hive", Host: "warehouse.local", User: "analyst", Password: "primary-secret",
		URI:              "jdbc:hive2://warehouse.local:10000/default;user=analyst;password=jdbc-secret",
		ConnectionParams: "authMode=KERBEROS&principal=hive%2Fwarehouse.local%40EXAMPLE.COM&password=params-secret&transportMode=http",
	}
	bundle := extractConnectionSecretBundle(config)
	public := stripConnectionSecretFields(config)
	if bundle.Password != config.Password || bundle.OpaqueURI != config.URI || !strings.Contains(bundle.SensitiveParams, "params-secret") {
		t.Fatalf("Hive secrets not retained in secret bundle: primary=%v uri=%v params=%v", bundle.Password != "", bundle.OpaqueURI != "", bundle.SensitiveParams != "")
	}
	if public.Password != "" || public.URI != "" || strings.Contains(public.ConnectionParams, "secret") {
		t.Fatal("Hive saved metadata exposed credentials")
	}
	params, err := url.ParseQuery(public.ConnectionParams)
	if err != nil || params.Get("authMode") != "KERBEROS" || params.Get("transportMode") != "http" {
		t.Fatalf("Hive non-secret authentication/transport settings lost: %s, %v", public.ConnectionParams, err)
	}
}

func TestHiveConnectionSummaryDoesNotExposeURIInHost(t *testing.T) {
	for _, host := range []string{
		"jdbc:hive2://analyst:primary-secret@warehouse.local:10000/default;password=jdbc-secret",
		"https://analyst:primary-secret@warehouse.local/cliservice?token=http-secret",
		"jdbc:hive2://warehouse.local:10000/default;password=jdbc-secret",
		"analyst:primary-secret@warehouse.local:10000",
	} {
		t.Run(host, func(t *testing.T) {
			summary := formatConnSummary(connection.ConnectionConfig{Type: "hive", Host: host})
			for _, secret := range []string{"primary-secret", "jdbc-secret", "http-secret", "jdbc:", "https://"} {
				if strings.Contains(summary, secret) {
					t.Fatalf("Hive connection log leaked endpoint secret %q", secret)
				}
			}
		})
	}
	for _, host := range []string{"warehouse.local", "127.0.0.1", "2001:db8::1"} {
		if got := connectionLogHost(host); got != host {
			t.Fatalf("plain endpoint changed: %q -> %q", host, got)
		}
	}
}

func TestHiveScheduledSQLBackupIsAvailable(t *testing.T) {
	if !backupSQLSupported("hive") {
		t.Fatal("Hive must support scheduled SQL backups")
	}
}
