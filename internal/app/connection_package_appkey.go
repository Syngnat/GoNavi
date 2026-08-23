package app

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

const (
	connectionPackageAppKeyPurpose      = "gonavi-export-key-v2"
	connectionPackageAppKeyFallbackSeed = "gonavi-connection-package-v2-seed"
	connectionPackageAppKeyFallbackSalt = "gonavi-connection-package-v2-salt"
)

var (
	connectionPackageAppKeySeed string
	connectionPackageAppKeySalt string

	connectionPackageAppKeyMu     sync.Mutex
	connectionPackageAppKeyCached []byte
)

func deriveConnectionPackageAppKey() ([]byte, error) {
	connectionPackageAppKeyMu.Lock()
	defer connectionPackageAppKeyMu.Unlock()

	if len(connectionPackageAppKeyCached) == connectionPackageAES256KeyBytes {
		return append([]byte(nil), connectionPackageAppKeyCached...), nil
	}

	seed := strings.TrimSpace(connectionPackageAppKeySeed)
	if seed == "" {
		seed = connectionPackageAppKeyFallbackSeed
	}
	saltValue := strings.TrimSpace(connectionPackageAppKeySalt)
	if saltValue == "" {
		saltValue = connectionPackageAppKeyFallbackSalt
	}

	mac := hmac.New(sha256.New, []byte(seed))
	if _, err := mac.Write([]byte(connectionPackageAppKeyPurpose)); err != nil {
		return nil, err
	}
	intermediate := mac.Sum(nil)

	saltHash := sha256.Sum256([]byte(saltValue))
	key := argon2.IDKey(
		intermediate,
		saltHash[:connectionPackageSaltBytes],
		connectionPackageKDFDefaultTimeCost,
		connectionPackageKDFDefaultMemoryKiB,
		connectionPackageKDFDefaultParallelism,
		connectionPackageAES256KeyBytes,
	)
	connectionPackageAppKeyCached = append([]byte(nil), key...)
	return append([]byte(nil), key...), nil
}

func resetConnectionPackageAppKeyCache() {
	connectionPackageAppKeyMu.Lock()
	defer connectionPackageAppKeyMu.Unlock()
	connectionPackageAppKeyCached = nil
}

func encryptSecretField(appKey []byte, plaintext string, aad string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	aead, err := newConnectionPackageAEAD(appKey)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, connectionPackageNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}

	ciphertext := aead.Seal(nil, nonce, []byte(plaintext), []byte(aad))
	encoded := make([]byte, 0, len(nonce)+len(ciphertext))
	encoded = append(encoded, nonce...)
	encoded = append(encoded, ciphertext...)
	return base64.StdEncoding.EncodeToString(encoded), nil
}

func decryptSecretField(appKey []byte, encrypted string, aad string) (string, error) {
	if encrypted == "" {
		return "", nil
	}

	raw, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		return "", err
	}
	if len(raw) <= connectionPackageNonceBytes {
		return "", errors.New("invalid encrypted secret")
	}

	aead, err := newConnectionPackageAEAD(appKey)
	if err != nil {
		return "", err
	}

	plain, err := aead.Open(nil, raw[:connectionPackageNonceBytes], raw[connectionPackageNonceBytes:], []byte(aad))
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func encryptSecretBundle(appKey []byte, bundle connectionSecretBundle, connectionID string) (connectionSecretBundle, error) {
	var encrypted connectionSecretBundle
	var err error

	encrypted.Password, err = encryptSecretField(appKey, bundle.Password, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.SSHPassword, err = encryptSecretField(appKey, bundle.SSHPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.ProxyPassword, err = encryptSecretField(appKey, bundle.ProxyPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.HTTPTunnelPassword, err = encryptSecretField(appKey, bundle.HTTPTunnelPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.MySQLReplicaPassword, err = encryptSecretField(appKey, bundle.MySQLReplicaPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.MongoReplicaPassword, err = encryptSecretField(appKey, bundle.MongoReplicaPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.RedisSentinelPassword, err = encryptSecretField(appKey, bundle.RedisSentinelPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.OpaqueURI, err = encryptSecretField(appKey, bundle.OpaqueURI, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.OpaqueDSN, err = encryptSecretField(appKey, bundle.OpaqueDSN, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.JVMJMXPassword, err = encryptSecretField(appKey, bundle.JVMJMXPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.JVMEndpointAPIKey, err = encryptSecretField(appKey, bundle.JVMEndpointAPIKey, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.JVMAgentAPIKey, err = encryptSecretField(appKey, bundle.JVMAgentAPIKey, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.JVMDiagnosticAPIKey, err = encryptSecretField(appKey, bundle.JVMDiagnosticAPIKey, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	encrypted.SensitiveParams, err = encryptSecretField(appKey, bundle.SensitiveParams, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}

	return encrypted, nil
}

func decryptSecretBundle(appKey []byte, bundle connectionSecretBundle, connectionID string) (connectionSecretBundle, error) {
	var decrypted connectionSecretBundle
	var err error

	decrypted.Password, err = decryptSecretField(appKey, bundle.Password, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.SSHPassword, err = decryptSecretField(appKey, bundle.SSHPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.ProxyPassword, err = decryptSecretField(appKey, bundle.ProxyPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.HTTPTunnelPassword, err = decryptSecretField(appKey, bundle.HTTPTunnelPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.MySQLReplicaPassword, err = decryptSecretField(appKey, bundle.MySQLReplicaPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.MongoReplicaPassword, err = decryptSecretField(appKey, bundle.MongoReplicaPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.RedisSentinelPassword, err = decryptSecretField(appKey, bundle.RedisSentinelPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.OpaqueURI, err = decryptSecretField(appKey, bundle.OpaqueURI, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.OpaqueDSN, err = decryptSecretField(appKey, bundle.OpaqueDSN, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.JVMJMXPassword, err = decryptSecretField(appKey, bundle.JVMJMXPassword, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.JVMEndpointAPIKey, err = decryptSecretField(appKey, bundle.JVMEndpointAPIKey, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.JVMAgentAPIKey, err = decryptSecretField(appKey, bundle.JVMAgentAPIKey, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.JVMDiagnosticAPIKey, err = decryptSecretField(appKey, bundle.JVMDiagnosticAPIKey, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	decrypted.SensitiveParams, err = decryptSecretField(appKey, bundle.SensitiveParams, connectionID)
	if err != nil {
		return connectionSecretBundle{}, err
	}

	return decrypted, nil
}
