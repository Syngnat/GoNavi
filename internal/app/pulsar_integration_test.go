package app

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

type pulsarPartialMetadataDB struct {
	*fakeMetadataRetryDB
	topic string
	err   error
}

func (p *pulsarPartialMetadataDB) GetTables(string) ([]string, error) {
	return []string{p.topic}, p.err
}

func TestPulsarObjectMetadataKeepsDefaultTopicWithDiscoveryWarning(t *testing.T) {
	previousFactory := newDatabaseFunc
	previousSupport := driverRuntimeSupportStatusFunc
	previousRevision := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = previousFactory
		driverRuntimeSupportStatusFunc = previousSupport
		verifyDriverAgentRevisionFunc = previousRevision
	})
	// Pulsar 已改为按需下载的驱动代理：这里模拟代理已安装，只验证部分结果的展示。
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }
	instance := &pulsarPartialMetadataDB{
		fakeMetadataRetryDB: &fakeMetadataRetryDB{},
		topic:               "persistent://public/default/orders",
		err:                 errors.New("admin topic listing denied"),
	}
	newDatabaseFunc = func(string) (db.Database, error) { return instance, nil }
	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := application.DBGetObjects(
		connection.ConnectionConfig{Type: "pulsar", Host: "localhost", Port: 6650}, "topics",
	)
	objects, ok := result.Data.([]connection.DatabaseObject)
	if !result.Success || !result.Partial || !result.Retryable || !ok || len(objects) != 1 || objects[0].Name != instance.topic {
		t.Fatalf("partial Pulsar metadata lost default topic: %#v", result)
	}
	if result.Message != application.appText("sidebar.message.pulsar_topic_discovery_partial", nil) || result.Message == "sidebar.message.pulsar_topic_discovery_partial" {
		t.Fatalf("missing explicit discovery warning: %q", result.Message)
	}
	tables := application.DBGetTables(
		connection.ConnectionConfig{Type: "pulsar", Host: "localhost", Port: 6650}, "topics",
	)
	rows, ok := tables.Data.([]map[string]string)
	if !tables.Success || !tables.Partial || !tables.Retryable || !ok || len(rows) != 1 || rows[0]["Table"] != instance.topic {
		t.Fatalf("partial Pulsar table list lost default topic: %#v", tables)
	}
}

func TestPulsarRegistrationAndMetadata(t *testing.T) {
	for _, kind := range []string{"pulsar", "apache-pulsar", "apache_pulsar"} {
		t.Run(kind, func(t *testing.T) {
			definition, ok := resolveDriverDefinitionWithPackages(kind, nil)
			if !ok || definition.BuiltIn {
				t.Fatal("Pulsar must be an optional driver agent")
			}
			inst, err := db.NewDatabase(kind)
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := inst.(*db.OptionalDriverAgentDB); !ok {
				t.Fatalf("wrong driver: %T", inst)
			}
			cfg := connection.ConnectionConfig{Type: kind, Database: "persistent://public/default/orders.events"}
			if normalizeRunConfig(cfg, "topics").Database != cfg.Database {
				t.Fatal("synthetic database replaced topic")
			}
			schema, topic := normalizeMetadataSchemaAndTable(cfg, "topics", cfg.Database)
			if schema != "topics" || topic != cfg.Database {
				t.Fatal("topic was split as schema.table")
			}
		})
	}
	if tableObjectTypeForDB("pulsar") != "topic" || !databaseObjectIdentifiersAreCaseSensitive("pulsar") {
		t.Fatal("topic metadata contract")
	}
	if _, ok := connectionExcelTypeSet["pulsar"]; !ok {
		t.Fatal("missing excel import type")
	}
}

func TestPulsarCommandsRespectReadOnlyAndSecretBoundaries(t *testing.T) {
	if !isReadOnlySQLQuery("pulsar", `CONSUME FROM "persistent://public/default/orders" EARLIEST LIMIT 10`) {
		t.Fatal("preview must be read-only")
	}
	if isReadOnlySQLQuery("pulsar", `{"publish":"orders","value":"test"}`) {
		t.Fatal("publish must be classified as a write")
	}
	public, sensitive := partitionConnectionParams("token=secret&authToken=other&startOffset=earliest")
	if strings.Contains(public, "secret") || strings.Contains(public, "other") || sensitive == "" {
		t.Fatal("Pulsar tokens must use the existing secret store")
	}
}
