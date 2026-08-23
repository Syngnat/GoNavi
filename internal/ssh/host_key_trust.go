package ssh

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"

	cryptossh "golang.org/x/crypto/ssh"
)

const (
	managedHostKeyTrustStoreVersion = 1
	sshHostKeyProbeTimeout          = 5 * time.Second
)

var (
	errSSHHostKeyCaptured      = errors.New("ssh host key captured")
	managedHostKeyTrustStoreMu sync.Mutex
)

// HostKeyTrustStatus is safe to return to the UI after an SSH handshake. It
// contains only the public host-key identity that a user must compare through
// a trusted channel; it never carries credentials or private-key material.
type HostKeyTrustStatus struct {
	State               string `json:"state"`
	Source              string `json:"source,omitempty"`
	Host                string `json:"host"`
	Port                int    `json:"port"`
	Address             string `json:"address"`
	KeyType             string `json:"keyType"`
	Fingerprint         string `json:"fingerprint"`
	PreviousFingerprint string `json:"previousFingerprint,omitempty"`
}

// HostKeyTrustRequiredError marks an unknown or changed host key discovered
// during the unauthenticated part of the SSH handshake.
type HostKeyTrustRequiredError struct {
	Status HostKeyTrustStatus
}

func (e *HostKeyTrustRequiredError) Error() string {
	if e == nil {
		return "SSH host key verification requires confirmation"
	}
	if e.Status.State == "changed" {
		return fmt.Sprintf("SSH host key changed for %s; verification requires confirmation", e.Status.Address)
	}
	return fmt.Sprintf("SSH host key verification requires confirmation for %s", e.Status.Address)
}

// HostKeyTrustStatusFromError extracts an interactive trust request even when
// the SSH or database layer wraps it with additional context.
func HostKeyTrustStatusFromError(err error) (HostKeyTrustStatus, bool) {
	var required *HostKeyTrustRequiredError
	if !errors.As(err, &required) || required == nil {
		return HostKeyTrustStatus{}, false
	}
	return required.Status, true
}

type managedHostKeyTrustStore struct {
	Version int                                  `json:"version"`
	Hosts   map[string]managedHostKeyTrustRecord `json:"hosts"`
}

type managedHostKeyTrustRecord struct {
	PublicKey string `json:"publicKey"`
}

func normalizeSSHAddress(host string, port int, missingHostMessage string) (string, int, error) {
	host = strings.TrimSpace(host)
	host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
	if host == "" {
		return "", 0, errors.New(missingHostMessage)
	}
	if port <= 0 {
		port = 22
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), port, nil
}

func sshHostKeyAddress(config connection.SSHConfig) (string, int, error) {
	host, port := config.HostKeyIdentity()
	return normalizeSSHAddress(host, port, "SSH host is required for host key verification")
}

func sshDialAddress(config connection.SSHConfig) (string, int, error) {
	return normalizeSSHAddress(config.Host, config.Port, "SSH host is required for connection")
}

func hostKeyTrustStatusForKey(config connection.SSHConfig, key cryptossh.PublicKey, state, source, previousFingerprint string) HostKeyTrustStatus {
	host, configuredPort := config.HostKeyIdentity()
	address, port, err := sshHostKeyAddress(config)
	if err != nil {
		address = strings.TrimSpace(host)
		port = configuredPort
	}
	return HostKeyTrustStatus{
		State:               state,
		Source:              source,
		Host:                strings.TrimSpace(host),
		Port:                port,
		Address:             address,
		KeyType:             key.Type(),
		Fingerprint:         cryptossh.FingerprintSHA256(key),
		PreviousFingerprint: strings.TrimSpace(previousFingerprint),
	}
}

func newHostKeyTrustRequiredError(config connection.SSHConfig, key cryptossh.PublicKey, state, source, previousFingerprint string) *HostKeyTrustRequiredError {
	return &HostKeyTrustRequiredError{
		Status: hostKeyTrustStatusForKey(config, key, state, source, previousFingerprint),
	}
}

func lookupManagedHostKey(storePath, address string) (cryptossh.PublicKey, bool, error) {
	storePath = strings.TrimSpace(storePath)
	if storePath == "" {
		return nil, false, nil
	}
	managedHostKeyTrustStoreMu.Lock()
	defer managedHostKeyTrustStoreMu.Unlock()
	store, err := readManagedHostKeyTrustStore(storePath)
	if err != nil {
		return nil, false, err
	}
	record, ok := store.Hosts[address]
	if !ok || strings.TrimSpace(record.PublicKey) == "" {
		return nil, false, nil
	}
	key, _, _, _, err := cryptossh.ParseAuthorizedKey([]byte(record.PublicKey))
	if err != nil {
		return nil, false, fmt.Errorf("parse GoNavi trusted SSH host key for %s: %w", address, err)
	}
	return key, true, nil
}

func readManagedHostKeyTrustStore(path string) (managedHostKeyTrustStore, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return managedHostKeyTrustStore{Version: managedHostKeyTrustStoreVersion, Hosts: map[string]managedHostKeyTrustRecord{}}, nil
	}
	if err != nil {
		return managedHostKeyTrustStore{}, fmt.Errorf("read GoNavi SSH trusted-host store: %w", err)
	}
	store := managedHostKeyTrustStore{}
	if err := json.Unmarshal(data, &store); err != nil {
		return managedHostKeyTrustStore{}, fmt.Errorf("parse GoNavi SSH trusted-host store: %w", err)
	}
	if store.Version != 0 && store.Version != managedHostKeyTrustStoreVersion {
		return managedHostKeyTrustStore{}, fmt.Errorf("unsupported GoNavi SSH trusted-host store version %d", store.Version)
	}
	store.Version = managedHostKeyTrustStoreVersion
	if store.Hosts == nil {
		store.Hosts = map[string]managedHostKeyTrustRecord{}
	}
	return store, nil
}

func writeManagedHostKeyTrustStore(path string, store managedHostKeyTrustStore) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create GoNavi SSH trusted-host directory: %w", err)
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return fmt.Errorf("encode GoNavi SSH trusted-host store: %w", err)
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), ".ssh-host-keys-*.json")
	if err != nil {
		return fmt.Errorf("create temporary GoNavi SSH trusted-host store: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("protect temporary GoNavi SSH trusted-host store: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write temporary GoNavi SSH trusted-host store: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary GoNavi SSH trusted-host store: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace GoNavi SSH trusted-host store: %w", err)
	}
	return nil
}

func persistManagedHostKey(storePath string, config connection.SSHConfig, key cryptossh.PublicKey) error {
	storePath = strings.TrimSpace(storePath)
	if storePath == "" {
		return errors.New("GoNavi SSH trusted-host store is unavailable")
	}
	address, _, err := sshHostKeyAddress(config)
	if err != nil {
		return err
	}
	managedHostKeyTrustStoreMu.Lock()
	defer managedHostKeyTrustStoreMu.Unlock()
	store, err := readManagedHostKeyTrustStore(storePath)
	if err != nil {
		return err
	}
	store.Hosts[address] = managedHostKeyTrustRecord{
		PublicKey: strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(key))),
	}
	return writeManagedHostKeyTrustStore(storePath, store)
}

// ProbeSSHHostKey reads the public host key exposed during an SSH handshake.
// Its callback always aborts before client authentication, so passwords and
// private keys are never sent while merely identifying a server.
func ProbeSSHHostKey(config connection.SSHConfig) (HostKeyTrustStatus, error) {
	dialAddress, _, err := sshDialAddress(config)
	if err != nil {
		return HostKeyTrustStatus{}, err
	}
	key, err := probeSSHHostPublicKey(config, dialAddress)
	if err != nil {
		return HostKeyTrustStatus{}, err
	}
	return hostKeyTrustStatusForKey(config, key, "unknown", "discovered", ""), nil
}

// TrustSSHHostKey re-reads the remote key before saving it to GoNavi's own
// trust store. The fingerprint must match the value just shown to the user;
// this prevents a key that changes between confirmation and persistence from
// being trusted accidentally.
func TrustSSHHostKey(config connection.SSHConfig, storePath, expectedFingerprint string) (HostKeyTrustStatus, error) {
	dialAddress, _, err := sshDialAddress(config)
	if err != nil {
		return HostKeyTrustStatus{}, err
	}
	key, err := probeSSHHostPublicKey(config, dialAddress)
	if err != nil {
		return HostKeyTrustStatus{}, err
	}
	actualFingerprint := cryptossh.FingerprintSHA256(key)
	expectedFingerprint = strings.TrimSpace(expectedFingerprint)
	if expectedFingerprint == "" || expectedFingerprint != actualFingerprint {
		return HostKeyTrustStatus{}, fmt.Errorf("SSH host key changed before it could be trusted: expected %s, got %s", expectedFingerprint, actualFingerprint)
	}
	if err := persistManagedHostKey(storePath, config, key); err != nil {
		return HostKeyTrustStatus{}, err
	}
	status := hostKeyTrustStatusForKey(config, key, "trusted", "gonavi", "")
	return status, nil
}

func probeSSHHostPublicKey(config connection.SSHConfig, address string) (cryptossh.PublicKey, error) {
	connection, err := net.DialTimeout("tcp", address, sshHostKeyProbeTimeout)
	if err != nil {
		return nil, fmt.Errorf("connect to SSH host for identity verification: %w", err)
	}
	defer func() { _ = connection.Close() }()
	// A TCP peer can accept the connection and then never send an SSH banner or
	// finish key exchange. Bound the whole unauthenticated probe, not just dial.
	if err := connection.SetDeadline(time.Now().Add(sshHostKeyProbeTimeout)); err != nil {
		return nil, fmt.Errorf("set SSH host-key probe deadline: %w", err)
	}
	var captured cryptossh.PublicKey
	clientConfig := &cryptossh.ClientConfig{
		User: "gonavi-host-key-probe",
		HostKeyCallback: func(_ string, _ net.Addr, key cryptossh.PublicKey) error {
			captured = key
			return errSSHHostKeyCaptured
		},
	}
	_, _, _, handshakeErr := cryptossh.NewClientConn(connection, address, clientConfig)
	if !errors.Is(handshakeErr, errSSHHostKeyCaptured) {
		if handshakeErr == nil {
			return nil, errors.New("SSH host-key probe unexpectedly completed without a host key")
		}
		return nil, fmt.Errorf("read SSH host key: %w", handshakeErr)
	}
	if captured == nil {
		return nil, errors.New("SSH host-key probe did not receive a host key")
	}
	return captured, nil
}

func managedHostKeyMatches(config connection.SSHConfig, key cryptossh.PublicKey) (bool, *HostKeyTrustRequiredError, error) {
	storePath := config.ManagedHostKeyTrustStorePath()
	if strings.TrimSpace(storePath) == "" {
		return false, nil, nil
	}
	address, _, err := sshHostKeyAddress(config)
	if err != nil {
		return false, nil, err
	}
	trustedKey, found, err := lookupManagedHostKey(storePath, address)
	if err != nil || !found {
		return false, nil, err
	}
	if bytes.Equal(trustedKey.Marshal(), key.Marshal()) {
		return true, nil, nil
	}
	return false, newHostKeyTrustRequiredError(
		config,
		key,
		"changed",
		"gonavi",
		cryptossh.FingerprintSHA256(trustedKey),
	), nil
}
