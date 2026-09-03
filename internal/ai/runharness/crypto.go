package runharness

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/secretstore"
)

var (
	ErrKeyUnavailable    = errors.New("agent ledger encryption key unavailable")
	ErrInvalidKey        = errors.New("agent ledger encryption key must be 32 bytes")
	ErrInvalidCiphertext = errors.New("invalid agent ledger ciphertext")
)

// KeyProvider obtains the 256-bit data-encryption key. Implementations must
// persist generated keys; returning a fresh key on every process start would
// make the ledger unrecoverable.
type KeyProvider interface {
	LoadOrCreate() ([]byte, error)
}

// StaticKeyProvider is useful for tests and for callers that already own a
// securely managed DEK. The key is copied on construction and retrieval.
type StaticKeyProvider struct{ key []byte }

func NewStaticKeyProvider(key []byte) (*StaticKeyProvider, error) {
	if len(key) != 32 {
		return nil, ErrInvalidKey
	}
	return &StaticKeyProvider{key: append([]byte(nil), key...)}, nil
}

func (p *StaticKeyProvider) LoadOrCreate() ([]byte, error) {
	if p == nil || len(p.key) != 32 {
		return nil, ErrInvalidKey
	}
	return append([]byte(nil), p.key...), nil
}

func (p *StaticKeyProvider) LoadOrCreateDetailed() (LoadedKey, error) {
	key, err := p.LoadOrCreate()
	if err != nil {
		return LoadedKey{}, err
	}
	return LoadedKey{Key: key}, nil
}

func (p *StaticKeyProvider) LoadExisting() (LoadedKey, bool, error) {
	loaded, err := p.LoadOrCreateDetailed()
	if err != nil {
		return LoadedKey{}, false, err
	}
	return loaded, true, nil
}

// KeyringKeyProvider stores the DEK in the OS keyring through GoNavi's shared
// secret-store abstraction. It never falls back to plaintext on keyring
// errors.
type KeyringKeyProvider struct {
	store secretstore.SecretStore
	ref   string
}

// keyringBackend is intentionally structural; it keeps the public ledger
// package independent of the concrete secret-store implementation.
type keyringBackend interface {
	Put(string, []byte) error
	Get(string) ([]byte, error)
	Delete(string) error
	HealthCheck() error
}

type structuralKeyringStore struct{ backend keyringBackend }

func (s structuralKeyringStore) Put(ref string, data []byte) error { return s.backend.Put(ref, data) }
func (s structuralKeyringStore) Get(ref string) ([]byte, error)    { return s.backend.Get(ref) }
func (s structuralKeyringStore) Delete(ref string) error           { return s.backend.Delete(ref) }
func (s structuralKeyringStore) HealthCheck() error                { return s.backend.HealthCheck() }

func newKeyringProviderFromInterface(ref string, backend keyringBackend) (*KeyringKeyProvider, error) {
	if backend == nil {
		return NewKeyringKeyProvider(ref, nil)
	}
	return NewKeyringKeyProvider(ref, structuralKeyringStore{backend: backend})
}

func NewKeyringKeyProvider(ref string, store secretstore.SecretStore) (*KeyringKeyProvider, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		var err error
		ref, err = secretstore.BuildRef("ai-ledger", "default")
		if err != nil {
			return nil, err
		}
	}
	if store == nil {
		store = secretstore.NewKeyringStore()
	}
	return &KeyringKeyProvider{store: store, ref: ref}, nil
}

// LoadedKey carries the loaded DEK plus whether this call generated it. A
// fresh key in front of an existing encrypted ledger means the original key
// is gone — for example macOS surfaces a denied Keychain ACL prompt as
// "item not found", which must never be mistaken for a first-time setup.
type LoadedKey struct {
	Key   []byte
	Fresh bool
}

// DetailedKeyProvider is an optional KeyProvider extension that reports key
// freshness so ledger open paths can refuse to re-key existing data.
type DetailedKeyProvider interface {
	LoadOrCreateDetailed() (LoadedKey, error)
}

// KeyLoader is an optional KeyProvider extension that reads the stored key
// without generating one. Opening an existing ledger must use it: minting a
// key for a missing keyring entry would overwrite the entry the moment access
// is granted again (macOS reports a denied Keychain ACL prompt as "item not
// found"), permanently destroying the original key.
type KeyLoader interface {
	LoadExisting() (LoadedKey, bool, error)
}

func (p *KeyringKeyProvider) LoadExisting() (LoadedKey, bool, error) {
	if p == nil || p.store == nil {
		return LoadedKey{}, false, ErrKeyUnavailable
	}
	key, err := p.store.Get(p.ref)
	if err == nil {
		if len(key) != 32 {
			return LoadedKey{}, false, fmt.Errorf("%w: keyring item has length %d", ErrInvalidKey, len(key))
		}
		return LoadedKey{Key: append([]byte(nil), key...)}, true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return LoadedKey{}, false, nil
	}
	return LoadedKey{}, false, fmt.Errorf("%w: %v", ErrKeyUnavailable, err)
}

func (p *KeyringKeyProvider) LoadOrCreateDetailed() (LoadedKey, error) {
	if p == nil || p.store == nil {
		return LoadedKey{}, ErrKeyUnavailable
	}
	key, err := p.store.Get(p.ref)
	if err == nil {
		if len(key) != 32 {
			return LoadedKey{}, fmt.Errorf("%w: keyring item has length %d", ErrInvalidKey, len(key))
		}
		return LoadedKey{Key: append([]byte(nil), key...)}, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return LoadedKey{}, fmt.Errorf("%w: %v", ErrKeyUnavailable, err)
	}
	key = make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return LoadedKey{}, fmt.Errorf("generate ledger key: %w", err)
	}
	if err := p.store.Put(p.ref, key); err != nil {
		return LoadedKey{}, fmt.Errorf("%w: store generated key: %v", ErrKeyUnavailable, err)
	}
	return LoadedKey{Key: append([]byte(nil), key...), Fresh: true}, nil
}

func (p *KeyringKeyProvider) LoadOrCreate() ([]byte, error) {
	loaded, err := p.LoadOrCreateDetailed()
	if err != nil {
		return nil, err
	}
	return loaded.Key, nil
}

// KeyFileProvider stores exactly 32 random bytes in a dedicated 0600 file.
// Symlink key files are rejected to prevent redirecting secret material.
type KeyFileProvider struct{ Path string }

func NewKeyFileProvider(path string) (*KeyFileProvider, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("key file path is empty")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve key file path: %w", err)
	}
	return &KeyFileProvider{Path: abs}, nil
}

func (p *KeyFileProvider) LoadOrCreate() ([]byte, error) {
	loaded, err := p.LoadOrCreateDetailed()
	if err != nil {
		return nil, err
	}
	return loaded.Key, nil
}

func (p *KeyFileProvider) LoadExisting() (LoadedKey, bool, error) {
	if p == nil || strings.TrimSpace(p.Path) == "" {
		return LoadedKey{}, false, errors.New("key file path is empty")
	}
	if _, err := os.Lstat(p.Path); errors.Is(err, os.ErrNotExist) {
		return LoadedKey{}, false, nil
	}
	loaded, err := p.LoadOrCreateDetailed()
	if err != nil {
		return LoadedKey{}, false, err
	}
	return loaded, true, nil
}

func (p *KeyFileProvider) LoadOrCreateDetailed() (LoadedKey, error) {
	if p == nil || strings.TrimSpace(p.Path) == "" {
		return LoadedKey{}, errors.New("key file path is empty")
	}
	path := p.Path
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return LoadedKey{}, fmt.Errorf("%w: key file is a symlink", ErrKeyUnavailable)
		}
		if !info.Mode().IsRegular() {
			return LoadedKey{}, fmt.Errorf("%w: key file is not regular", ErrKeyUnavailable)
		}
		if info.Mode().Perm() != 0o600 {
			return LoadedKey{}, fmt.Errorf("%w: key file permissions are %04o, want 0600", ErrKeyUnavailable, info.Mode().Perm())
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return LoadedKey{}, fmt.Errorf("%w: read key file: %v", ErrKeyUnavailable, readErr)
		}
		if len(data) != 32 {
			// Accept a textual 64-character hex or 44-character base64 key for
			// operators provisioning a key file manually, while still requiring
			// the decoded value to be exactly 256 bits.
			if decoded, err := decodeTextKey(data); err == nil {
				data = decoded
			}
		}
		if len(data) != 32 {
			return LoadedKey{}, fmt.Errorf("%w: key file has length %d", ErrInvalidKey, len(data))
		}
		return LoadedKey{Key: append([]byte(nil), data...)}, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return LoadedKey{}, fmt.Errorf("%w: inspect key file: %v", ErrKeyUnavailable, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return LoadedKey{}, fmt.Errorf("%w: create key directory: %v", ErrKeyUnavailable, err)
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return LoadedKey{}, fmt.Errorf("generate ledger key: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return p.LoadOrCreateDetailed()
		}
		return LoadedKey{}, fmt.Errorf("%w: create key file: %v", ErrKeyUnavailable, err)
	}
	if _, err = file.Write(key); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		_ = os.Remove(path)
		return LoadedKey{}, fmt.Errorf("%w: write key file: %v", ErrKeyUnavailable, errors.Join(err, closeErr))
	}
	return LoadedKey{Key: key, Fresh: true}, nil
}

func decodeTextKey(data []byte) ([]byte, error) {
	text := strings.TrimSpace(string(data))
	if len(text) == 64 {
		// Decode each byte strictly. Sscanf accepts partial input in a few
		// malformed cases, which could make an operator believe a different
		// key was loaded than the one actually persisted.
		if decoded, err := hexDecode(text); err == nil {
			return decoded, nil
		}
	}
	if len(text) >= 43 && len(text) <= 48 {
		if decoded, err := base64.StdEncoding.DecodeString(text); err == nil {
			return decoded, nil
		}
	}
	return nil, ErrInvalidKey
}

func hexDecode(text string) ([]byte, error) {
	const digits = "0123456789abcdefABCDEF"
	if len(text)%2 != 0 {
		return nil, ErrInvalidKey
	}
	result := make([]byte, len(text)/2)
	for i := range result {
		hi, lo := strings.IndexByte(digits, text[i*2]), strings.IndexByte(digits, text[i*2+1])
		if hi < 0 || lo < 0 {
			return nil, ErrInvalidKey
		}
		result[i] = byte(hi&15)<<4 | byte(lo&15)
	}
	return result, nil
}

// Cipher encrypts sensitive ledger values with AES-256-GCM. The serialized
// value is version byte 1 followed by nonce and ciphertext.
type Cipher struct{ aead cipher.AEAD }

func NewCipher(key []byte) (*Cipher, error) {
	if len(key) != 32 {
		return nil, ErrInvalidKey
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create AES cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM cipher: %w", err)
	}
	return &Cipher{aead: aead}, nil
}

func (c *Cipher) Encrypt(plaintext, associatedData []byte) ([]byte, error) {
	if c == nil || c.aead == nil {
		return nil, ErrKeyUnavailable
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}
	sealed := c.aead.Seal(nil, nonce, plaintext, associatedData)
	result := make([]byte, 1+len(nonce)+len(sealed))
	result[0] = 1
	copy(result[1:], nonce)
	copy(result[1+len(nonce):], sealed)
	return result, nil
}

func (c *Cipher) Decrypt(ciphertext, associatedData []byte) ([]byte, error) {
	if c == nil || c.aead == nil {
		return nil, ErrKeyUnavailable
	}
	minimum := 1 + c.aead.NonceSize() + c.aead.Overhead()
	if len(ciphertext) < minimum || ciphertext[0] != 1 {
		return nil, ErrInvalidCiphertext
	}
	nonce := ciphertext[1 : 1+c.aead.NonceSize()]
	plaintext, err := c.aead.Open(nil, nonce, ciphertext[1+c.aead.NonceSize():], associatedData)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidCiphertext, err)
	}
	return plaintext, nil
}

// ConstantTimeEqual is exposed for approval/hash checks and avoids accidental
// ordinary string comparisons in security-sensitive adapter code.
func ConstantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}
