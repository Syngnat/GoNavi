//go:build gonavi_mongodb_driver_v1

package db

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	cryptossh "golang.org/x/crypto/ssh"
)

func TestMongoSSHDialerV1RoutesAllMembersThroughSSH(t *testing.T) {
	tests := []struct {
		name       string
		uri        string
		wantScheme string
	}{
		{name: "standard", uri: "mongodb://mongo.internal:27017/app", wantScheme: "mongodb://"},
		{name: "srv", uri: "mongodb+srv://cluster.example.test/app", wantScheme: "mongodb+srv://"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			config := applyMongoURI(connection.ConnectionConfig{
				URI:    tt.uri,
				UseSSH: true,
				SSH: connection.SSHConfig{
					Host: "bastion.example.test",
					Port: 22,
					User: "operator",
				},
			})
			if uri := (&MongoDBV1{}).getURI(config); !strings.HasPrefix(uri, tt.wantScheme) {
				t.Fatalf("expected URI scheme %q, got %q", tt.wantScheme, uri)
			}

			dialer := mongoConnectionDialer(config)
			sshDialer, ok := dialer.(*mongoSSHDialer)
			if !ok {
				t.Fatalf("expected SSH dialer, got %T", dialer)
			}

			wantErr := errors.New("dial stopped")
			var addresses []string
			sshDialer.dialContext = func(_ context.Context, _ connection.SSHConfig, network, address string) (net.Conn, error) {
				if network != "tcp" {
					t.Fatalf("expected tcp network, got %q", network)
				}
				addresses = append(addresses, address)
				return nil, wantErr
			}

			for _, address := range []string{"mongo-1.internal:27017", "mongo-2.internal:27018"} {
				if _, err := dialer.DialContext(context.Background(), "tcp", address); !errors.Is(err, wantErr) {
					t.Fatalf("expected SSH dial error for %s, got %v", address, err)
				}
			}
			if strings.Join(addresses, ",") != "mongo-1.internal:27017,mongo-2.internal:27018" {
				t.Fatalf("unexpected SSH targets: %v", addresses)
			}
		})
	}
}

func TestMongoConnectV1PreservesSSHHostKeyTrustErrorBeforeDriverDial(t *testing.T) {
	originalGetOrCreate := mongoGetOrCreateSSHClient
	t.Cleanup(func() { mongoGetOrCreateSSHClient = originalGetOrCreate })

	want := &ssh.HostKeyTrustRequiredError{Status: ssh.HostKeyTrustStatus{
		State:       "unknown",
		Host:        "bastion.example.test",
		Port:        22,
		Address:     "bastion.example.test:22",
		KeyType:     "ssh-ed25519",
		Fingerprint: "SHA256:untrusted-key",
	}}
	var preflightConfig connection.SSHConfig
	mongoGetOrCreateSSHClient = func(config connection.SSHConfig) (*cryptossh.Client, error) {
		preflightConfig = config
		return nil, want
	}

	err := (&MongoDBV1{}).Connect(connection.ConnectionConfig{
		Type:   "mongodb",
		Host:   "mongo.internal.example",
		Port:   defaultMongoPort,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "bastion.example.test",
			Port: 22,
			User: "operator",
		},
	})
	if err == nil {
		t.Fatal("expected SSH host-key trust error")
	}
	if preflightConfig.Host != "bastion.example.test" || preflightConfig.Port != 22 {
		t.Fatalf("unexpected SSH preflight config: %+v", preflightConfig)
	}

	var got *ssh.HostKeyTrustRequiredError
	if !errors.As(err, &got) {
		t.Fatalf("expected HostKeyTrustRequiredError to remain unwrapable, got %T: %v", err, err)
	}
	if got != want {
		t.Fatalf("unexpected SSH host-key trust error: got %#v, want %#v", got, want)
	}
}

func TestApplyMongoURIV1_ExplicitHostDoesNotAdoptURIHosts(t *testing.T) {
	config := connection.ConnectionConfig{
		Host: "10.10.10.10",
		Port: 27017,
		URI:  "mongodb://localhost:27017/admin",
	}

	got := applyMongoURI(config)
	if got.Host != "10.10.10.10" {
		t.Fatalf("expected host to remain explicit, got %q", got.Host)
	}
	if len(got.Hosts) != 0 {
		t.Fatalf("expected hosts to remain empty when explicit host exists, got %v", got.Hosts)
	}
}

func TestBuildMongoChangeFilterV1_ConvertsExplicitOIDToObjectID(t *testing.T) {
	const oidHex = "507f1f77bcf86cd799439011"

	filter := buildMongoChangeFilter(map[string]interface{}{
		"_id":  map[string]interface{}{"$oid": oidHex},
		"name": oidHex,
	})

	gotID, ok := filter["_id"].(primitive.ObjectID)
	if !ok {
		t.Fatalf("expected _id to be primitive.ObjectID, got %T", filter["_id"])
	}
	if gotID.Hex() != oidHex {
		t.Fatalf("unexpected ObjectID: got=%s want=%s", gotID.Hex(), oidHex)
	}
	if filter["name"] != oidHex {
		t.Fatalf("non-_id 24 hex string should stay string, got %T %v", filter["name"], filter["name"])
	}
}

func TestBuildMongoChangeFilterV1_LeavesIDHexStringUntouched(t *testing.T) {
	const oidHex = "507f1f77bcf86cd799439011"

	filter := buildMongoChangeFilter(map[string]interface{}{
		"_id": oidHex,
	})

	if filter["_id"] != oidHex {
		t.Fatalf("plain _id string should stay string, got %T %v", filter["_id"], filter["_id"])
	}
}

func TestBuildMongoObjectIDLocatorValueV1_EncodesObjectID(t *testing.T) {
	const oidHex = "507f1f77bcf86cd799439011"
	oid, err := primitive.ObjectIDFromHex(oidHex)
	if err != nil {
		t.Fatal(err)
	}

	locator := buildMongoObjectIDLocatorValue(oid)
	locatorMap, ok := locator.(bson.M)
	if !ok {
		t.Fatalf("expected locator bson.M, got %T", locator)
	}
	if locatorMap["$oid"] != oidHex {
		t.Fatalf("unexpected locator value: %v", locatorMap["$oid"])
	}
}

func TestCopyMongoChangeDocumentV1_LeavesInsertIDStringUntouched(t *testing.T) {
	const oidHex = "507f1f77bcf86cd799439011"

	doc := copyMongoChangeDocument(map[string]interface{}{
		"_id": oidHex,
	})

	if doc["_id"] != oidHex {
		t.Fatalf("insert _id string should stay string, got %T %v", doc["_id"], doc["_id"])
	}
}

func TestConvertBsonValueV1_EncodesMongoTypedValues(t *testing.T) {
	const oidHex = "507f1f77bcf86cd799439011"
	oid, err := primitive.ObjectIDFromHex(oidHex)
	if err != nil {
		t.Fatal(err)
	}
	decimalValue, err := primitive.ParseDecimal128("12.34")
	if err != nil {
		t.Fatal(err)
	}

	converted, ok := convertBsonValue(bson.M{
		"_id":       oid,
		"createdAt": primitive.DateTime(1719100800000),
		"count32":   int32(7),
		"count64":   int64(8),
		"ratio":     1.5,
		"price":     decimalValue,
		"uid": primitive.Binary{
			Subtype: 0x04,
			Data:    []byte{0x12, 0x34, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78},
		},
		"nested": bson.M{
			"innerId": oid,
		},
		"items": bson.A{int32(1), int64(2)},
	}).(map[string]interface{})
	if !ok {
		t.Fatalf("expected converted document map, got %T", converted)
	}

	if converted["_id"].(map[string]interface{})["$oid"] != oidHex {
		t.Fatalf("unexpected ObjectID wrapper: %#v", converted["_id"])
	}
	if converted["createdAt"].(map[string]interface{})["$date"].(map[string]interface{})["$numberLong"] != "1719100800000" {
		t.Fatalf("unexpected date wrapper: %#v", converted["createdAt"])
	}
	if converted["count32"].(map[string]interface{})["$numberInt"] != "7" {
		t.Fatalf("unexpected int32 wrapper: %#v", converted["count32"])
	}
	if converted["count64"].(map[string]interface{})["$numberLong"] != "8" {
		t.Fatalf("unexpected int64 wrapper: %#v", converted["count64"])
	}
	if converted["ratio"] != 1.5 {
		t.Fatalf("plain double should stay float64, got %T %#v", converted["ratio"], converted["ratio"])
	}
	if converted["price"].(map[string]interface{})["$numberDecimal"] != "12.34" {
		t.Fatalf("unexpected decimal wrapper: %#v", converted["price"])
	}
	if converted["uid"].(map[string]interface{})["$binary"].(map[string]interface{})["base64"] != "EjRWeBI0VngSNFZ4EjRWeA==" {
		t.Fatalf("unexpected binary wrapper: %#v", converted["uid"])
	}

	nestedDoc, ok := converted["nested"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected nested map, got %T", converted["nested"])
	}
	if nestedDoc["innerId"].(map[string]interface{})["$oid"] != oidHex {
		t.Fatalf("unexpected nested ObjectID wrapper: %#v", nestedDoc["innerId"])
	}

	items, ok := converted["items"].([]interface{})
	if !ok || len(items) != 2 {
		t.Fatalf("unexpected items wrapper: %#v", converted["items"])
	}
	if items[0].(map[string]interface{})["$numberInt"] != "1" || items[1].(map[string]interface{})["$numberLong"] != "2" {
		t.Fatalf("unexpected numeric array wrappers: %#v", items)
	}
}

func TestCopyMongoChangeDocumentV1_DecodesExtendedJSONWrappers(t *testing.T) {
	doc := copyMongoChangeDocument(map[string]interface{}{
		"_id":       map[string]interface{}{"$oid": "507f1f77bcf86cd799439011"},
		"createdAt": map[string]interface{}{"$date": map[string]interface{}{"$numberLong": "1719100800000"}},
		"count32":   map[string]interface{}{"$numberInt": "7"},
		"count64":   map[string]interface{}{"$numberLong": "8"},
		"ratio":     map[string]interface{}{"$numberDouble": "1.5"},
		"price":     map[string]interface{}{"$numberDecimal": "12.34"},
		"uid": map[string]interface{}{
			"$binary": map[string]interface{}{
				"base64":  "EjRWeBI0VngSNFZ4EjRWeA==",
				"subType": "04",
			},
		},
		"nested": map[string]interface{}{
			"innerId": map[string]interface{}{"$oid": "507f1f77bcf86cd799439012"},
		},
		"items": []interface{}{
			map[string]interface{}{"$numberInt": "1"},
			map[string]interface{}{"$numberLong": "2"},
		},
	})

	if _, ok := doc["_id"].(primitive.ObjectID); !ok {
		t.Fatalf("expected _id to decode to primitive.ObjectID, got %T", doc["_id"])
	}
	if got, ok := doc["createdAt"].(primitive.DateTime); !ok || got != primitive.DateTime(1719100800000) {
		t.Fatalf("expected createdAt primitive.DateTime, got %T %#v", doc["createdAt"], doc["createdAt"])
	}
	if got, ok := doc["count32"].(int32); !ok || got != 7 {
		t.Fatalf("expected count32 int32, got %T %#v", doc["count32"], doc["count32"])
	}
	if got, ok := doc["count64"].(int64); !ok || got != 8 {
		t.Fatalf("expected count64 int64, got %T %#v", doc["count64"], doc["count64"])
	}
	if got, ok := doc["ratio"].(float64); !ok || got != 1.5 {
		t.Fatalf("expected ratio float64, got %T %#v", doc["ratio"], doc["ratio"])
	}
	if _, ok := doc["price"].(primitive.Decimal128); !ok {
		t.Fatalf("expected price primitive.Decimal128, got %T", doc["price"])
	}
	if binaryValue, ok := doc["uid"].(primitive.Binary); !ok || binaryValue.Subtype != 0x04 || len(binaryValue.Data) != 16 {
		t.Fatalf("expected uid primitive.Binary UUID, got %T %#v", doc["uid"], doc["uid"])
	}

	nestedDoc, ok := doc["nested"].(primitive.M)
	if !ok {
		t.Fatalf("expected nested primitive.M, got %T %#v", doc["nested"], doc["nested"])
	}
	if _, ok := nestedDoc["innerId"].(primitive.ObjectID); !ok {
		t.Fatalf("expected nested innerId ObjectID, got %T", nestedDoc["innerId"])
	}

	items, ok := doc["items"].(bson.A)
	if !ok || len(items) != 2 {
		t.Fatalf("expected items bson.A, got %T %#v", doc["items"], doc["items"])
	}
	if got, ok := items[0].(int32); !ok || got != 1 {
		t.Fatalf("expected items[0] int32, got %T %#v", items[0], items[0])
	}
	if got, ok := items[1].(int64); !ok || got != 2 {
		t.Fatalf("expected items[1] int64, got %T %#v", items[1], items[1])
	}
}
