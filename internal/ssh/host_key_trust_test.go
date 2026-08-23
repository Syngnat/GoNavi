package ssh

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	cryptossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestManagedHostKeyTrustRequestsConfirmationThenVerifies(t *testing.T) {
	useEmptySSHHome(t)
	signer := newTestHostSigner(t)
	server := startTestSSHServer(t, signer)
	storePath := filepath.Join(t.TempDir(), "ssh", "trusted-hosts.json")
	config := server.config().WithManagedHostKeyTrustStore(storePath)

	client, err := connectSSH(config)
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("expected an unknown managed host key to require confirmation")
	}
	status, ok := HostKeyTrustStatusFromError(err)
	if !ok {
		t.Fatalf("expected trust request error, got %T: %v", err, err)
	}
	if status.State != "unknown" {
		t.Fatalf("expected unknown host key state, got %#v", status)
	}
	if status.Fingerprint != cryptossh.FingerprintSHA256(signer.PublicKey()) {
		t.Fatalf("unexpected discovered fingerprint: %#v", status)
	}

	trusted, err := TrustSSHHostKey(server.config(), storePath, status.Fingerprint)
	if err != nil {
		t.Fatalf("TrustSSHHostKey() error = %v", err)
	}
	if trusted.State != "trusted" || trusted.Source != "gonavi" {
		t.Fatalf("unexpected trust result: %#v", trusted)
	}
	if _, err := os.Stat(storePath); err != nil {
		t.Fatalf("managed host-key store was not persisted: %v", err)
	}

	client, err = connectSSH(config)
	if err != nil {
		t.Fatalf("connectSSH() after explicit trust error = %v", err)
	}
	_ = client.Close()
}

func TestManagedHostKeyTrustRejectsChangedServerKey(t *testing.T) {
	useEmptySSHHome(t)
	server := startTestSSHServer(t, newTestHostSigner(t))
	storePath := filepath.Join(t.TempDir(), "ssh", "trusted-hosts.json")
	config := server.config()
	oldKey := newTestHostSigner(t).PublicKey()
	if err := persistManagedHostKey(storePath, config, oldKey); err != nil {
		t.Fatalf("persist managed host key: %v", err)
	}

	client, err := connectSSH(config.WithManagedHostKeyTrustStore(storePath))
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("expected a changed managed host key to be rejected")
	}
	status, ok := HostKeyTrustStatusFromError(err)
	if !ok {
		t.Fatalf("expected trust request error, got %T: %v", err, err)
	}
	if status.State != "changed" {
		t.Fatalf("expected changed host key state, got %#v", status)
	}
	if status.PreviousFingerprint != cryptossh.FingerprintSHA256(oldKey) {
		t.Fatalf("expected previous fingerprint to be surfaced, got %#v", status)
	}
	if status.Fingerprint == status.PreviousFingerprint {
		t.Fatalf("expected a distinct observed host key, got %#v", status)
	}
}

func TestManagedHostKeyTrustStoreReplacesExistingRecord(t *testing.T) {
	storePath := filepath.Join(t.TempDir(), "ssh", "trusted-hosts.json")
	config := connection.SSHConfig{Host: "bastion.example.com", Port: 22}
	firstKey := newTestHostSigner(t).PublicKey()
	secondKey := newTestHostSigner(t).PublicKey()

	if err := persistManagedHostKey(storePath, config, firstKey); err != nil {
		t.Fatalf("persist first managed host key: %v", err)
	}
	if err := persistManagedHostKey(storePath, config, secondKey); err != nil {
		t.Fatalf("replace managed host key: %v", err)
	}
	address, _, err := sshHostKeyAddress(config)
	if err != nil {
		t.Fatalf("derive SSH host-key address: %v", err)
	}
	got, found, err := lookupManagedHostKey(storePath, address)
	if err != nil || !found {
		t.Fatalf("load replaced managed host key: found=%v err=%v", found, err)
	}
	if !bytes.Equal(got.Marshal(), secondKey.Marshal()) {
		t.Fatalf("managed host key was not replaced")
	}
}

func TestManagedHostKeyTrustStoreDoesNotChangeConnectionJSON(t *testing.T) {
	config := connection.SSHConfig{Host: "bastion.example.com", Port: 22}.
		WithManagedHostKeyTrustStore("C:/private/gonavi-host-keys.json")
	if got := config.ManagedHostKeyTrustStorePath(); got != "C:/private/gonavi-host-keys.json" {
		t.Fatalf("managed trust-store path = %q", got)
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("marshal SSH config: %v", err)
	}
	if strings.Contains(string(encoded), "gonavi-host-keys.json") {
		t.Fatalf("runtime trust-store path leaked into persisted config: %s", encoded)
	}
}

func TestManagedHostKeyTrustKeepsLogicalIdentityWhenDialingProxyEndpoint(t *testing.T) {
	useEmptySSHHome(t)
	signer := newTestHostSigner(t)
	server := startTestSSHServer(t, signer)
	storePath := filepath.Join(t.TempDir(), "ssh", "trusted-hosts.json")
	config := server.config().
		WithHostKeyIdentity("bastion.example.test", 2222).
		WithManagedHostKeyTrustStore(storePath)

	client, err := connectSSH(config)
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("expected unknown logical host key to require confirmation")
	}
	requested, ok := HostKeyTrustStatusFromError(err)
	if !ok {
		t.Fatalf("expected trust request, got %T: %v", err, err)
	}
	if requested.Address != "bastion.example.test:2222" {
		t.Fatalf("trust request used physical dial endpoint instead of logical host: %#v", requested)
	}

	trusted, err := TrustSSHHostKey(config, storePath, requested.Fingerprint)
	if err != nil {
		t.Fatalf("trust logical host through physical endpoint: %v", err)
	}
	if trusted.Address != "bastion.example.test:2222" {
		t.Fatalf("trusted status used physical dial endpoint: %#v", trusted)
	}
	logicalAddress, _, err := sshHostKeyAddress(config)
	if err != nil {
		t.Fatalf("logical address: %v", err)
	}
	physicalAddress, _, err := sshDialAddress(config)
	if err != nil {
		t.Fatalf("physical address: %v", err)
	}
	if _, found, err := lookupManagedHostKey(storePath, logicalAddress); err != nil || !found {
		t.Fatalf("logical trust record missing: found=%v err=%v", found, err)
	}
	if _, found, err := lookupManagedHostKey(storePath, physicalAddress); err != nil {
		t.Fatalf("read physical address record: %v", err)
	} else if found {
		t.Fatalf("managed trust record must not be keyed by proxy endpoint %s", physicalAddress)
	}

	client, err = connectSSH(config)
	if err != nil {
		t.Fatalf("connect after trusting logical host: %v", err)
	}
	_ = client.Close()
}

func TestKnownHostsVerificationUsesLogicalIdentityWhenDialingProxyEndpoint(t *testing.T) {
	useEmptySSHHome(t)
	signer := newTestHostSigner(t)
	server := startTestSSHServer(t, signer)
	config := server.config().WithHostKeyIdentity("bastion.example.test", 2222)
	logicalAddress, _, err := sshHostKeyAddress(config)
	if err != nil {
		t.Fatalf("logical address: %v", err)
	}
	knownHostsPath := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(knownHostsPath, []byte(knownhosts.Line([]string{logicalAddress}, signer.PublicKey())+"\n"), 0o600); err != nil {
		t.Fatalf("write logical known_hosts record: %v", err)
	}
	config.KnownHostsPath = knownHostsPath
	// A legacy pin happens to match the presented key, but the explicitly
	// selected known_hosts policy must still reject its changed record.
	config.HostKeyFingerprint = cryptossh.FingerprintSHA256(signer.PublicKey())

	client, err := connectSSH(config)
	if err != nil {
		t.Fatalf("verify physical dial using logical known_hosts record: %v", err)
	}
	_ = client.Close()
}

func TestManagedTrustSurfacesLegacyPinnedKeyChangeForMigration(t *testing.T) {
	useEmptySSHHome(t)
	server := startTestSSHServer(t, newTestHostSigner(t))
	legacyKey := newTestHostSigner(t).PublicKey()
	config := server.config().WithManagedHostKeyTrustStore(filepath.Join(t.TempDir(), "trusted-hosts.json"))
	config.HostKeyFingerprint = cryptossh.FingerprintSHA256(legacyKey)

	client, err := connectSSH(config)
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("expected changed legacy pin to require explicit migration")
	}
	status, ok := HostKeyTrustStatusFromError(err)
	if !ok {
		t.Fatalf("expected structured legacy trust request, got %T: %v", err, err)
	}
	if status.State != "changed" || status.Source != "legacy" || status.PreviousFingerprint != config.HostKeyFingerprint {
		t.Fatalf("unexpected legacy migration request: %#v", status)
	}
}

func TestExplicitKnownHostsPolicyCannotBeBypassedByManagedTrustStore(t *testing.T) {
	useEmptySSHHome(t)
	signer := newTestHostSigner(t)
	server := startTestSSHServer(t, signer)
	storePath := filepath.Join(t.TempDir(), "ssh", "trusted-hosts.json")
	knownHostsPath := filepath.Join(t.TempDir(), "explicit-known_hosts")
	config := server.config().WithManagedHostKeyTrustStore(storePath)
	if err := persistManagedHostKey(storePath, config, signer.PublicKey()); err != nil {
		t.Fatalf("persist managed record: %v", err)
	}
	if err := os.WriteFile(
		knownHostsPath,
		[]byte(knownhosts.Line([]string{server.address}, newTestHostSigner(t).PublicKey())+"\n"),
		0o600,
	); err != nil {
		t.Fatalf("write explicit known_hosts policy: %v", err)
	}
	config.KnownHostsPath = knownHostsPath

	client, err := connectSSH(config)
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("explicit known_hosts mismatch must not be bypassed by managed trust")
	}
	var keyErr *knownhosts.KeyError
	if !errors.As(err, &keyErr) {
		t.Fatalf("expected explicit known_hosts error, got %T: %v", err, err)
	}
	if _, ok := HostKeyTrustStatusFromError(err); ok {
		t.Fatal("explicit known_hosts mismatch must not offer managed-key replacement")
	}
}

func TestDefaultKnownHostsRevocationCannotBeBypassedByManagedTrustStore(t *testing.T) {
	useEmptySSHHome(t)
	signer := newTestHostSigner(t)
	server := startTestSSHServer(t, signer)
	storePath := filepath.Join(t.TempDir(), "ssh", "trusted-hosts.json")
	config := server.config().WithManagedHostKeyTrustStore(storePath)
	if err := persistManagedHostKey(storePath, config, signer.PublicKey()); err != nil {
		t.Fatalf("persist managed record: %v", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("resolve test SSH home: %v", err)
	}
	knownHostsPath := filepath.Join(home, ".ssh", "known_hosts")
	if err := os.MkdirAll(filepath.Dir(knownHostsPath), 0o700); err != nil {
		t.Fatalf("create test .ssh directory: %v", err)
	}
	revokedLine := "@revoked " + knownhosts.Line([]string{server.address}, signer.PublicKey())
	if err := os.WriteFile(knownHostsPath, []byte(revokedLine+"\n"), 0o600); err != nil {
		t.Fatalf("write revoked default known_hosts record: %v", err)
	}

	client, err := connectSSH(config)
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("revoked default known_hosts record must reject a matching managed key")
	}
	var revokedErr *knownhosts.RevokedError
	if !errors.As(err, &revokedErr) {
		t.Fatalf("expected known_hosts revocation error, got %T: %v", err, err)
	}
	if _, ok := HostKeyTrustStatusFromError(err); ok {
		t.Fatal("revoked host key must not offer a managed-key confirmation")
	}
}

func TestDefaultKnownHostsCertificateValidationFailureCannotBeBypassedByManagedTrustStore(t *testing.T) {
	useEmptySSHHome(t)
	config := connection.SSHConfig{Host: "127.0.0.1", Port: 2222}
	storePath := filepath.Join(t.TempDir(), "ssh", "trusted-hosts.json")
	config = config.WithManagedHostKeyTrustStore(storePath)

	hostSigner := newTestHostSigner(t)
	caSigner := newTestHostSigner(t)
	expiredCertificate := &cryptossh.Certificate{
		Key:             hostSigner.PublicKey(),
		CertType:        cryptossh.HostCert,
		KeyId:           "expired-host-certificate",
		ValidPrincipals: []string{"127.0.0.1"},
		ValidAfter:      0,
		ValidBefore:     uint64(time.Now().Add(-time.Hour).Unix()),
	}
	if err := expiredCertificate.SignCert(rand.Reader, caSigner); err != nil {
		t.Fatalf("sign expired host certificate: %v", err)
	}
	if err := persistManagedHostKey(storePath, config, expiredCertificate); err != nil {
		t.Fatalf("persist managed certificate record: %v", err)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("resolve test SSH home: %v", err)
	}
	knownHostsPath := filepath.Join(home, ".ssh", "known_hosts")
	if err := os.MkdirAll(filepath.Dir(knownHostsPath), 0o700); err != nil {
		t.Fatalf("create test .ssh directory: %v", err)
	}
	certificateAuthorityLine := "@cert-authority " + knownhosts.Line([]string{"127.0.0.1:2222"}, caSigner.PublicKey())
	if err := os.WriteFile(knownHostsPath, []byte(certificateAuthorityLine+"\n"), 0o600); err != nil {
		t.Fatalf("write default known_hosts certificate authority: %v", err)
	}

	callback, err := newKnownHostsOrManagedHostKeyCallback(config)
	if err != nil {
		t.Fatalf("build host-key callback: %v", err)
	}
	err = callback("127.0.0.1:2222", &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 2222}, expiredCertificate)
	if err == nil {
		t.Fatal("expired certificate in default known_hosts policy must not be bypassed by a matching managed key")
	}
	var keyErr *knownhosts.KeyError
	if errors.As(err, &keyErr) {
		t.Fatalf("expected certificate validation error, got KeyError: %v", err)
	}
	if _, ok := HostKeyTrustStatusFromError(err); ok {
		t.Fatalf("certificate validation error must not offer managed-key confirmation: %v", err)
	}
}
