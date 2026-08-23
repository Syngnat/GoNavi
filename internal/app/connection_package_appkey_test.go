package app

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
)

func TestDeriveConnectionPackageAppKeyIsStable(t *testing.T) {
	originalSeed := connectionPackageAppKeySeed
	originalSalt := connectionPackageAppKeySalt
	t.Cleanup(func() {
		connectionPackageAppKeySeed = originalSeed
		connectionPackageAppKeySalt = originalSalt
		resetConnectionPackageAppKeyCache()
	})

	connectionPackageAppKeySeed = "unit-test-seed"
	connectionPackageAppKeySalt = "unit-test-salt"
	resetConnectionPackageAppKeyCache()

	first, err := deriveConnectionPackageAppKey()
	if err != nil {
		t.Fatalf("deriveConnectionPackageAppKey returned error: %v", err)
	}
	second, err := deriveConnectionPackageAppKey()
	if err != nil {
		t.Fatalf("deriveConnectionPackageAppKey returned error on second call: %v", err)
	}
	if len(first) != connectionPackageAES256KeyBytes {
		t.Fatalf("expected %d-byte app key, got %d", connectionPackageAES256KeyBytes, len(first))
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("expected deriveConnectionPackageAppKey to be stable across repeated calls")
	}

	connectionPackageAppKeySeed = "unit-test-seed-rotated"
	resetConnectionPackageAppKeyCache()
	rotated, err := deriveConnectionPackageAppKey()
	if err != nil {
		t.Fatalf("deriveConnectionPackageAppKey returned error after seed rotation: %v", err)
	}
	if reflect.DeepEqual(first, rotated) {
		t.Fatal("expected different injected seed to produce a different app key")
	}
}

func TestEncryptSecretFieldRoundTrip(t *testing.T) {
	appKey := []byte("0123456789abcdef0123456789abcdef")

	encrypted, err := encryptSecretField(appKey, "super-secret", "conn-1")
	if err != nil {
		t.Fatalf("encryptSecretField returned error: %v", err)
	}
	if strings.HasPrefix(encrypted, "ENC:") {
		t.Fatalf("encrypted field must not carry ENC prefix, got %q", encrypted)
	}
	raw, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		t.Fatalf("encrypted field must be base64, got error: %v", err)
	}
	if len(raw) <= connectionPackageNonceBytes {
		t.Fatalf("expected nonce+ciphertext output, got %d bytes", len(raw))
	}

	decrypted, err := decryptSecretField(appKey, encrypted, "conn-1")
	if err != nil {
		t.Fatalf("decryptSecretField returned error: %v", err)
	}
	if decrypted != "super-secret" {
		t.Fatalf("round-trip mismatch: got %q", decrypted)
	}
}

func TestDecryptSecretFieldRejectsAADMismatch(t *testing.T) {
	appKey := []byte("0123456789abcdef0123456789abcdef")

	encrypted, err := encryptSecretField(appKey, "super-secret", "conn-1")
	if err != nil {
		t.Fatalf("encryptSecretField returned error: %v", err)
	}

	if _, err := decryptSecretField(appKey, encrypted, "conn-2"); err == nil {
		t.Fatal("expected decryptSecretField to reject mismatched AAD")
	}
}

func TestEncryptSecretBundleRoundTripAndAADBinding(t *testing.T) {
	appKey := []byte("0123456789abcdef0123456789abcdef")
	plain := connectionSecretBundle{
		Password:              "primary-secret",
		SSHPassword:           "ssh-secret",
		ProxyPassword:         "proxy-secret",
		HTTPTunnelPassword:    "http-secret",
		MySQLReplicaPassword:  "mysql-secret",
		MongoReplicaPassword:  "mongo-secret",
		RedisSentinelPassword: "sentinel-secret",
		OpaqueURI:             "postgres://user:pass@db.local/app",
		OpaqueDSN:             "server=db.local;password=secret",
		JVMJMXPassword:        "jmx-secret",
		JVMEndpointAPIKey:     "endpoint-key",
		JVMAgentAPIKey:        "agent-key",
		JVMDiagnosticAPIKey:   "diagnostic-key",
		SensitiveParams:       "accessToken=param-secret",
	}

	encrypted, err := encryptSecretBundle(appKey, plain, "conn-1")
	if err != nil {
		t.Fatalf("encryptSecretBundle returned error: %v", err)
	}

	for name, value := range map[string]string{
		"password":              encrypted.Password,
		"sshPassword":           encrypted.SSHPassword,
		"proxyPassword":         encrypted.ProxyPassword,
		"httpTunnelPassword":    encrypted.HTTPTunnelPassword,
		"mysqlReplicaPassword":  encrypted.MySQLReplicaPassword,
		"mongoReplicaPassword":  encrypted.MongoReplicaPassword,
		"redisSentinelPassword": encrypted.RedisSentinelPassword,
		"opaqueURI":             encrypted.OpaqueURI,
		"opaqueDSN":             encrypted.OpaqueDSN,
		"jvmJMXPassword":        encrypted.JVMJMXPassword,
		"jvmEndpointAPIKey":     encrypted.JVMEndpointAPIKey,
		"jvmAgentAPIKey":        encrypted.JVMAgentAPIKey,
		"jvmDiagnosticAPIKey":   encrypted.JVMDiagnosticAPIKey,
		"sensitiveParams":       encrypted.SensitiveParams,
	} {
		if value == "" {
			t.Fatalf("expected encrypted %s field to be populated", name)
		}
		if strings.HasPrefix(value, "ENC:") {
			t.Fatalf("encrypted %s field must not carry ENC prefix", name)
		}
		if value == plain.Password || value == plain.SSHPassword || value == plain.ProxyPassword ||
			value == plain.HTTPTunnelPassword || value == plain.MySQLReplicaPassword || value == plain.MongoReplicaPassword ||
			value == plain.RedisSentinelPassword ||
			value == plain.OpaqueURI || value == plain.OpaqueDSN || value == plain.JVMJMXPassword ||
			value == plain.JVMEndpointAPIKey || value == plain.JVMAgentAPIKey ||
			value == plain.JVMDiagnosticAPIKey || value == plain.SensitiveParams {
			t.Fatalf("expected encrypted %s field to differ from plaintext", name)
		}
	}

	decrypted, err := decryptSecretBundle(appKey, encrypted, "conn-1")
	if err != nil {
		t.Fatalf("decryptSecretBundle returned error: %v", err)
	}
	if !reflect.DeepEqual(decrypted, plain) {
		t.Fatalf("bundle round-trip mismatch: got=%+v want=%+v", decrypted, plain)
	}

	if _, err := decryptSecretBundle(appKey, encrypted, "conn-2"); err == nil {
		t.Fatal("expected decryptSecretBundle to reject mismatched connection AAD")
	}
}
