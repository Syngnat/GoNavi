package secretstore

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"testing"

	"github.com/99designs/keyring"
)

func TestStoreStatusValuesRemainStable(t *testing.T) {
	t.Parallel()

	if StatusAvailable != "available" {
		t.Fatalf("expected StatusAvailable to remain stable, got %q", StatusAvailable)
	}
	if StatusUnavailable != "unavailable" {
		t.Fatalf("expected StatusUnavailable to remain stable, got %q", StatusUnavailable)
	}
}

func TestBuildRefRejectsEmptyKind(t *testing.T) {
	t.Parallel()

	if _, err := BuildRef("", "secret-id"); err == nil {
		t.Fatal("BuildRef should reject an empty kind")
	}
}

func TestBuildRefRejectsEmptyID(t *testing.T) {
	t.Parallel()

	if _, err := BuildRef("database", ""); err == nil {
		t.Fatal("BuildRef should reject an empty id")
	}
}

func TestUnavailableStoreHealthCheckReturnsUnavailableError(t *testing.T) {
	t.Parallel()

	store := NewUnavailableStore("keyring backend disabled")

	err := store.HealthCheck()
	if err == nil {
		t.Fatal("HealthCheck should return an unavailable error")
	}

	if !IsUnavailable(err) {
		t.Fatalf("HealthCheck error should be detected by IsUnavailable, got %T", err)
	}
}

func TestKeyringStoreHealthCheckTreatsMissingProbeItemAsHealthy(t *testing.T) {
	t.Parallel()

	store := &keyringStore{ring: fakeKeyringClient{getErr: keyring.ErrKeyNotFound}}
	if err := store.HealthCheck(); err != nil {
		t.Fatalf("HealthCheck should accept ErrKeyNotFound, got %v", err)
	}
}

func TestKeyringStoreHealthCheckTreatsWinCredNotFoundMessageAsHealthy(t *testing.T) {
	t.Parallel()

	store := &keyringStore{ring: fakeKeyringClient{getErr: errors.New("The specified item could not be found in the keyring")}}
	if err := store.HealthCheck(); err != nil {
		t.Fatalf("HealthCheck should accept WinCred not-found errors, got %v", err)
	}
}

func TestKeyringStoreHealthCheckDoesNotTreatWrappedOsErrNotExistAsHealthy(t *testing.T) {
	t.Parallel()

	store := &keyringStore{ring: fakeKeyringClient{getErr: fmt.Errorf("backend unavailable: %w", os.ErrNotExist)}}
	if err := store.HealthCheck(); err == nil {
		t.Fatal("HealthCheck should not accept unrelated wrapped os.ErrNotExist errors as healthy")
	}
}

func TestKeyringStoreHealthCheckDoesNotTreatPlainOsErrNotExistAsHealthy(t *testing.T) {
	t.Parallel()

	store := &keyringStore{ring: fakeKeyringClient{getErr: os.ErrNotExist}}
	if err := store.HealthCheck(); err == nil {
		t.Fatal("HealthCheck should not accept plain os.ErrNotExist errors as healthy")
	}
}

func TestKeyringStoreHealthCheckReturnsUnavailableErrorOnBackendFailure(t *testing.T) {
	t.Parallel()

	store := &keyringStore{ring: fakeKeyringClient{getErr: errors.New("backend offline")}}
	if err := store.HealthCheck(); err == nil || !IsUnavailable(err) {
		t.Fatalf("HealthCheck should wrap backend failures as unavailable, got %v", err)
	}
}

func TestNewKeyringStoreReturnsUnavailableStoreWhenOpenFails(t *testing.T) {
	t.Parallel()

	store := newKeyringStoreWithOpener("windows", func(cfg keyring.Config) (keyring.Keyring, error) {
		if len(cfg.AllowedBackends) != 1 || cfg.AllowedBackends[0] != keyring.WinCredBackend {
			t.Fatalf("unexpected backend config: %#v", cfg.AllowedBackends)
		}
		return nil, errors.New("no backend")
	})

	if err := store.HealthCheck(); err == nil || !IsUnavailable(err) {
		t.Fatalf("expected unavailable store when open fails, got %v", err)
	}
}

func TestKeyringStorePutWritesIdentifyingMetadata(t *testing.T) {
	ref := "oskeyring://gonavi/agent-ledger/test"
	payload := []byte("secret")
	var stored keyring.Item
	store := &keyringStore{ring: fakeKeyringClient{set: func(item keyring.Item) error {
		stored = item
		return nil
	}}}

	if err := store.Put(ref, payload); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if stored.Key != ref || string(stored.Data) != string(payload) {
		t.Fatalf("stored keyring item = %+v, want original key and payload", stored)
	}
	if stored.Label == "" || stored.Description == "" {
		t.Fatalf("stored keyring item metadata is blank: %+v", stored)
	}
}

func TestKeyringStoreGetMigratesBlankMacOSMetadataAfterSuccessfulRead(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Keychain label migration is only used on macOS")
	}
	ref := "oskeyring://gonavi/agent-ledger/test"
	payload := []byte("existing-secret")
	var migrations []keyring.Item
	store := &keyringStore{
		ring: fakeKeyringClient{
			item: keyring.Item{Key: ref, Data: payload},
			set: func(item keyring.Item) error {
				migrations = append(migrations, item)
				return nil
			},
		},
	}

	got, err := store.Get(ref)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("Get payload = %q, want %q", got, payload)
	}
	if len(migrations) != 1 {
		t.Fatalf("metadata migrations = %d, want 1", len(migrations))
	}
	if migrations[0].Key != ref || string(migrations[0].Data) != string(payload) || migrations[0].Label == "" || migrations[0].Description == "" {
		t.Fatalf("metadata migration item = %+v, want populated metadata and original payload", migrations[0])
	}
}

func TestWrapKeyringErrorNormalizesWinCredNotFoundMessage(t *testing.T) {
	t.Parallel()

	err := wrapKeyringError(errors.New("The specified item could not be found in the keyring"))
	if err == nil {
		t.Fatal("wrapKeyringError should preserve missing-secret semantics")
	}
	if !os.IsNotExist(err) {
		t.Fatalf("wrapKeyringError should map WinCred not-found errors to os.ErrNotExist, got %v", err)
	}
	if IsUnavailable(err) {
		t.Fatalf("wrapKeyringError should not treat WinCred not-found errors as unavailable, got %v", err)
	}
}

func TestWrapKeyringErrorNormalizesWrappedKeyringErrKeyNotFound(t *testing.T) {
	t.Parallel()

	err := wrapKeyringError(fmt.Errorf("wrapped: %w", keyring.ErrKeyNotFound))
	if err == nil {
		t.Fatal("wrapKeyringError should preserve wrapped missing-secret semantics")
	}
	if !os.IsNotExist(err) {
		t.Fatalf("wrapKeyringError should map wrapped ErrKeyNotFound to os.ErrNotExist, got %v", err)
	}
	if IsUnavailable(err) {
		t.Fatalf("wrapKeyringError should not treat wrapped ErrKeyNotFound as unavailable, got %v", err)
	}
}

func TestWrapKeyringErrorNormalizesWinCredErrno1168(t *testing.T) {
	t.Parallel()

	err := wrapKeyringError(syscall.Errno(1168))
	if err == nil {
		t.Fatal("wrapKeyringError should preserve WinCred errno missing-secret semantics")
	}
	if !os.IsNotExist(err) {
		t.Fatalf("wrapKeyringError should map WinCred errno to os.ErrNotExist, got %v", err)
	}
	if IsUnavailable(err) {
		t.Fatalf("wrapKeyringError should not treat WinCred errno as unavailable, got %v", err)
	}
}

func TestWrapKeyringErrorDoesNotSwallowUnrelatedElementNotFoundMessages(t *testing.T) {
	t.Parallel()

	backendErr := errors.New("database element not found while enumerating providers")
	err := wrapKeyringError(backendErr)
	if err == nil {
		t.Fatal("wrapKeyringError should preserve backend failures")
	}
	if os.IsNotExist(err) {
		t.Fatalf("wrapKeyringError should not map unrelated element-not-found errors to os.ErrNotExist, got %v", err)
	}
	if !IsUnavailable(err) {
		t.Fatalf("wrapKeyringError should keep unrelated backend failures unavailable, got %v", err)
	}
}

type fakeKeyringClient struct {
	getErr    error
	item      keyring.Item
	removeErr error
	set       func(keyring.Item) error
}

func (f fakeKeyringClient) Get(string) (keyring.Item, error) {
	if f.getErr != nil {
		return keyring.Item{}, f.getErr
	}
	return f.item, nil
}

func (f fakeKeyringClient) Set(item keyring.Item) error {
	if f.set != nil {
		return f.set(item)
	}
	return nil
}

func (f fakeKeyringClient) Remove(string) error {
	return f.removeErr
}

func (f fakeKeyringClient) GetMetadata(string) (keyring.Metadata, error) {
	return keyring.Metadata{}, nil
}

func (f fakeKeyringClient) Keys() ([]string, error) {
	return nil, nil
}
