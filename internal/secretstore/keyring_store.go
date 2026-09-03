package secretstore

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"

	"github.com/99designs/keyring"
)

type keyringClient interface {
	Get(key string) (keyring.Item, error)
	Set(item keyring.Item) error
	Remove(key string) error
}

type keyringStore struct {
	ring keyringClient
}

type keyringOpener func(cfg keyring.Config) (keyring.Keyring, error)

const keyringItemLabel = "GoNavi"

func NewKeyringStore() SecretStore {
	return newKeyringStoreWithOpener(runtime.GOOS, keyring.Open)
}

func newKeyringStoreWithOpener(goos string, open keyringOpener) SecretStore {
	cfg, err := keyringConfigFor(goos)
	if err != nil {
		return NewUnavailableStore(err.Error())
	}

	ring, err := open(cfg)
	if err != nil {
		return NewUnavailableStore(err.Error())
	}

	return &keyringStore{ring: ring}
}

func (s *keyringStore) Put(ref string, payload []byte) error {
	// Label and Description surface in macOS Keychain ACL prompts; without a
	// label the prompt names the item as "" and users cannot tell which app
	// or secret is asking for permission.
	return wrapKeyringError(s.ring.Set(keyringItem(ref, payload)))
}

func keyringItem(ref string, payload []byte) keyring.Item {
	return keyring.Item{
		Key:         ref,
		Data:        payload,
		Label:       keyringItemLabel,
		Description: ref,
	}
}

func (s *keyringStore) Get(ref string) ([]byte, error) {
	item, err := s.ring.Get(ref)
	if err != nil {
		return nil, wrapKeyringError(err)
	}
	if runtime.GOOS == "darwin" && strings.TrimSpace(item.Label) == "" {
		// Existing versions stored items without a Keychain label. Only migrate
		// after the original payload has been read successfully, so a denied ACL
		// prompt can never overwrite an encryption key. The upstream Keychain
		// backend updates this metadata without replacing the item's ACL.
		_ = s.ring.Set(keyringItem(ref, item.Data))
	}
	return item.Data, nil
}

func (s *keyringStore) Delete(ref string) error {
	return wrapKeyringError(s.ring.Remove(ref))
}

func (s *keyringStore) HealthCheck() error {
	_, err := s.ring.Get(healthCheckRef)
	if err == nil || isKeyringSecretNotFound(err) {
		return nil
	}
	return wrapKeyringError(err)
}

func wrapKeyringError(err error) error {
	if err == nil || IsUnavailable(err) {
		return err
	}
	if isKeyringSecretNotFound(err) {
		return os.ErrNotExist
	}
	return &UnavailableError{Reason: err.Error()}
}

func isKeyringSecretNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, keyring.ErrKeyNotFound) || errors.Is(err, syscall.Errno(1168)) {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(err.Error()), keyring.ErrKeyNotFound.Error())
}

func keyringConfigFor(goos string) (keyring.Config, error) {
	backends := allowedBackendsFor(goos)
	if len(backends) == 0 {
		return keyring.Config{}, fmt.Errorf("unsupported keyring platform: %s", goos)
	}

	return keyring.Config{
		ServiceName:                    serviceName,
		AllowedBackends:                backends,
		KeychainTrustApplication:       true,
		KeychainAccessibleWhenUnlocked: true,
		LibSecretCollectionName:        "default",
		KeyCtlScope:                    "user",
		WinCredPrefix:                  serviceName,
	}, nil
}

func allowedBackendsFor(goos string) []keyring.BackendType {
	switch goos {
	case "windows":
		return []keyring.BackendType{keyring.WinCredBackend}
	case "darwin":
		return []keyring.BackendType{keyring.KeychainBackend}
	case "linux":
		return []keyring.BackendType{
			keyring.SecretServiceBackend,
			keyring.KWalletBackend,
			keyring.KeyCtlBackend,
		}
	default:
		return nil
	}
}
