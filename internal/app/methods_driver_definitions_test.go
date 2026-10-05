package app

import (
	"testing"
)

func TestIRISDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("iris")
	if !ok {
		t.Fatal("expected iris driver definition")
	}
	if definition.Name != "InterSystems IRIS" {
		t.Fatalf("unexpected iris driver name: %q", definition.Name)
	}
	if driverGoModulePathMap["iris"] != "github.com/caretdev/go-irisnative" {
		t.Fatalf("unexpected iris go module path: %q", driverGoModulePathMap["iris"])
	}
	if definition.PinnedVersion != "0.2.1" {
		t.Fatalf("unexpected iris definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/iris" {
		t.Fatalf("unexpected iris default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["iris"] != "0.2.1" {
		t.Fatalf("unexpected iris pinned version: %q", latestDriverVersionMap["iris"])
	}

	tags, err := optionalDriverBuildTags("iris", "")
	if err != nil {
		t.Fatalf("resolve iris build tags failed: %v", err)
	}
	if tags != "gonavi_iris_driver" {
		t.Fatalf("unexpected iris build tag: %q", tags)
	}
}

func TestCacheDriverDefinitionUsesIndependentOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("cache")
	if !ok {
		t.Fatal("expected cache driver definition")
	}
	if definition.Name != "InterSystems Caché" || definition.PinnedVersion != "0.2.1" {
		t.Fatalf("unexpected cache definition: %#v", definition)
	}
	if driverGoModulePathMap["cache"] != "github.com/caretdev/go-irisnative" {
		t.Fatalf("unexpected cache module path: %q", driverGoModulePathMap["cache"])
	}
	if got, err := optionalDriverBuildTags("cache", ""); err != nil || got != "gonavi_cache_driver" {
		t.Fatalf("unexpected cache build tag=%q err=%v", got, err)
	}
}

func TestElasticsearchDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("elasticsearch")
	if !ok {
		t.Fatal("expected elasticsearch driver definition")
	}
	if definition.Name != "Elasticsearch" {
		t.Fatalf("unexpected elasticsearch driver name: %q", definition.Name)
	}
	if definition.BuiltIn {
		t.Fatal("expected elasticsearch to be an optional driver agent")
	}
	if driverGoModulePathMap["elasticsearch"] != "github.com/elastic/go-elasticsearch/v8" {
		t.Fatalf("unexpected elasticsearch go module path: %q", driverGoModulePathMap["elasticsearch"])
	}
	if definition.PinnedVersion != "8.19.6" {
		t.Fatalf("unexpected elasticsearch definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/elasticsearch" {
		t.Fatalf("unexpected elasticsearch default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["elasticsearch"] != "8.19.6" {
		t.Fatalf("unexpected elasticsearch pinned version: %q", latestDriverVersionMap["elasticsearch"])
	}

	tags, err := optionalDriverBuildTags("elasticsearch", "")
	if err != nil {
		t.Fatalf("resolve elasticsearch build tags failed: %v", err)
	}
	if tags != "gonavi_elasticsearch_driver" {
		t.Fatalf("unexpected elasticsearch build tag: %q", tags)
	}
}

func TestTrinoDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("trino")
	if !ok {
		t.Fatal("expected trino driver definition")
	}
	if definition.Name != "Trino" {
		t.Fatalf("unexpected trino driver name: %q", definition.Name)
	}
	if definition.BuiltIn {
		t.Fatal("expected trino to be an optional driver agent")
	}
	if driverGoModulePathMap["trino"] != "github.com/trinodb/trino-go-client" {
		t.Fatalf("unexpected trino go module path: %q", driverGoModulePathMap["trino"])
	}
	if definition.PinnedVersion != "0.333.0" {
		t.Fatalf("unexpected trino definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/trino" {
		t.Fatalf("unexpected trino default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["trino"] != "0.333.0" {
		t.Fatalf("unexpected trino pinned version: %q", latestDriverVersionMap["trino"])
	}

	tags, err := optionalDriverBuildTags("trino", "")
	if err != nil {
		t.Fatalf("resolve trino build tags failed: %v", err)
	}
	if tags != "gonavi_trino_driver" {
		t.Fatalf("unexpected trino build tag: %q", tags)
	}
}

func TestIoTDBDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("iotdb")
	if !ok {
		t.Fatal("expected iotdb driver definition")
	}
	if definition.Name != "Apache IoTDB" {
		t.Fatalf("unexpected iotdb driver name: %q", definition.Name)
	}
	if definition.BuiltIn {
		t.Fatal("expected iotdb to be an optional driver agent")
	}
	if driverGoModulePathMap["iotdb"] != "github.com/apache/iotdb-client-go" {
		t.Fatalf("unexpected iotdb go module path: %q", driverGoModulePathMap["iotdb"])
	}
	if definition.PinnedVersion != "1.3.7" {
		t.Fatalf("unexpected iotdb definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/iotdb" {
		t.Fatalf("unexpected iotdb default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["iotdb"] != "1.3.7" {
		t.Fatalf("unexpected iotdb pinned version: %q", latestDriverVersionMap["iotdb"])
	}

	tags, err := optionalDriverBuildTags("iotdb", "")
	if err != nil {
		t.Fatalf("resolve iotdb build tags failed: %v", err)
	}
	if tags != "gonavi_iotdb_driver" {
		t.Fatalf("unexpected iotdb build tag: %q", tags)
	}
}

func TestMessageQueueDriverDefinitionsUseOptionalAgent(t *testing.T) {
	cases := []struct {
		alias   string
		name    string
		version string
		module  string
	}{
		{alias: "apache-kafka", name: "Kafka", version: "0.4.51", module: "github.com/segmentio/kafka-go"},
		{alias: "rmq", name: "RocketMQ", version: "2.1.2", module: "github.com/apache/rocketmq-client-go/v2"},
		{alias: "apache-pulsar", name: "Apache Pulsar", version: "0.21.0", module: "github.com/apache/pulsar-client-go"},
	}
	for _, tc := range cases {
		definition, ok := resolveDriverDefinition(tc.alias)
		if !ok {
			t.Fatalf("expected %s driver definition", tc.alias)
		}
		if definition.Name != tc.name || definition.BuiltIn {
			t.Fatalf("expected %s to be the optional driver agent %q: %#v", tc.alias, tc.name, definition)
		}
		if definition.PinnedVersion != tc.version {
			t.Fatalf("unexpected %s pinned version: %q", tc.alias, definition.PinnedVersion)
		}
		if driverGoModulePathMap[definition.Type] != tc.module {
			t.Fatalf("unexpected %s go module path: %q", tc.alias, driverGoModulePathMap[definition.Type])
		}
		if tag, err := optionalDriverBuildTag(definition.Type, ""); err != nil || tag != "gonavi_"+definition.Type+"_driver" {
			t.Fatalf("unexpected %s build tag: %q, %v", tc.alias, tag, err)
		}
	}
}

func TestMQTTDriverDefinitionIsBuiltIn(t *testing.T) {
	definition, ok := resolveDriverDefinition("mqtts")
	if !ok {
		t.Fatal("expected mqtt driver definition")
	}
	if definition.Name != "MQTT" {
		t.Fatalf("unexpected mqtt driver name: %q", definition.Name)
	}
	if !definition.BuiltIn {
		t.Fatal("expected mqtt to be a built-in driver")
	}
	if definition.PinnedVersion != "" || definition.DefaultDownloadURL != "" {
		t.Fatalf("expected mqtt builtin definition to omit optional-agent metadata: %#v", definition)
	}
}

func TestRabbitMQDriverDefinitionIsBuiltIn(t *testing.T) {
	definition, ok := resolveDriverDefinition("rabbit-mq")
	if !ok {
		t.Fatal("expected rabbitmq driver definition")
	}
	if definition.Name != "RabbitMQ" {
		t.Fatalf("unexpected rabbitmq driver name: %q", definition.Name)
	}
	if !definition.BuiltIn {
		t.Fatal("expected rabbitmq to be a built-in driver")
	}
	if definition.PinnedVersion != "" || definition.DefaultDownloadURL != "" {
		t.Fatalf("expected rabbitmq builtin definition to omit optional-agent metadata: %#v", definition)
	}
}

func TestGoldenDBDriverDefinitionIsBuiltIn(t *testing.T) {
	definition, ok := resolveDriverDefinition("greatdb")
	if !ok {
		t.Fatal("expected goldendb driver definition")
	}
	if definition.Name != "GoldenDB" {
		t.Fatalf("unexpected goldendb driver name: %q", definition.Name)
	}
	if !definition.BuiltIn {
		t.Fatal("expected goldendb to be a built-in driver")
	}
	if definition.PinnedVersion != "" || definition.DefaultDownloadURL != "" {
		t.Fatalf("expected goldendb builtin definition to omit optional metadata: %#v", definition)
	}
	if latestDriverVersionMap["goldendb"] != "1.9.3" {
		t.Fatalf("unexpected goldendb pinned version: %q", latestDriverVersionMap["goldendb"])
	}
	if driverGoModulePathMap["goldendb"] != "github.com/go-sql-driver/mysql" {
		t.Fatalf("unexpected goldendb go module path: %q", driverGoModulePathMap["goldendb"])
	}
}

func TestGaussDBDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("gaussdb")
	if !ok {
		t.Fatal("expected gaussdb driver definition")
	}
	if definition.Name != "GaussDB" {
		t.Fatalf("unexpected gaussdb driver name: %q", definition.Name)
	}
	if definition.BuiltIn {
		t.Fatal("expected gaussdb to be an optional driver agent")
	}
	if driverGoModulePathMap["gaussdb"] != "github.com/HuaweiCloudDeveloper/gaussdb-go" {
		t.Fatalf("unexpected gaussdb go module path: %q", driverGoModulePathMap["gaussdb"])
	}
	if definition.PinnedVersion != "v1.0.0-rc1" {
		t.Fatalf("unexpected gaussdb definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/gaussdb" {
		t.Fatalf("unexpected gaussdb default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["gaussdb"] != "v1.0.0-rc1" {
		t.Fatalf("unexpected gaussdb pinned version: %q", latestDriverVersionMap["gaussdb"])
	}

	tags, err := optionalDriverBuildTags("gaussdb", "")
	if err != nil {
		t.Fatalf("resolve gaussdb build tags failed: %v", err)
	}
	if tags != "gonavi_gaussdb_driver" {
		t.Fatalf("unexpected gaussdb build tag: %q", tags)
	}
}
