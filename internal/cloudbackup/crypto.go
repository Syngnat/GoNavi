package cloudbackup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	envelopeVersion    = 1
	envelopeKind       = "gonavi_cloud_backup"
	envelopeCipher     = "AES-256-GCM"
	envelopeKDF        = "Argon2id"
	keyBytes           = 32
	saltBytes          = 16
	nonceBytes         = 12
	defaultMemoryKiB   = 65536
	defaultTimeCost    = 3
	defaultParallelism = 4
	maxMemoryKiB       = 262144
	maxTimeCost        = 10
	maxParallelism     = 16
	maxCiphertextBytes = 64 * 1024 * 1024
	maxEnvelopeBytes   = 96 * 1024 * 1024
)

var (
	errPasswordRequired = errors.New("cloud backup encryption password cannot be empty")
	errInvalidEnvelope  = errors.New("invalid cloud backup envelope")
	errDecryptFailed    = errors.New("cloud backup password is incorrect or the payload is corrupted")
)

type envelope struct {
	V       int    `json:"v"`
	Kind    string `json:"kind"`
	Cipher  string `json:"cipher"`
	KDF     string `json:"kdf"`
	Memory  uint32 `json:"memoryKiB"`
	Time    uint32 `json:"timeCost"`
	Threads uint8  `json:"parallelism"`
	Salt    string `json:"salt"`
	Nonce   string `json:"nonce"`
	Payload string `json:"payload"`
}

func Encrypt(payload []byte, password string) ([]byte, error) {
	if strings.TrimSpace(password) == "" {
		return nil, errPasswordRequired
	}
	if len(payload) > maxCiphertextBytes {
		return nil, fmt.Errorf("cloud backup payload exceeds %d bytes", maxCiphertextBytes)
	}

	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	key := deriveKey(password, salt, defaultMemoryKiB, defaultTimeCost, defaultParallelism)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	metadata := envelope{
		V: envelopeVersion, Kind: envelopeKind, Cipher: envelopeCipher, KDF: envelopeKDF,
		Memory: defaultMemoryKiB, Time: defaultTimeCost, Threads: defaultParallelism,
		Salt: base64.StdEncoding.EncodeToString(salt), Nonce: base64.StdEncoding.EncodeToString(nonce),
	}
	aad, err := json.Marshal(metadata)
	if err != nil {
		return nil, err
	}
	metadata.Payload = base64.StdEncoding.EncodeToString(aead.Seal(nil, nonce, payload, aad))
	encoded, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(encoded) > maxEnvelopeBytes {
		return nil, fmt.Errorf("cloud backup envelope exceeds %d bytes", maxEnvelopeBytes)
	}
	return encoded, nil
}

func Decrypt(raw []byte, password string) ([]byte, error) {
	if strings.TrimSpace(password) == "" {
		return nil, errPasswordRequired
	}
	if len(raw) > maxEnvelopeBytes {
		return nil, fmt.Errorf("cloud backup envelope exceeds %d bytes", maxEnvelopeBytes)
	}
	var value envelope
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, errInvalidEnvelope
	}
	if value.V != envelopeVersion || value.Kind != envelopeKind || value.Cipher != envelopeCipher || value.KDF != envelopeKDF {
		return nil, errInvalidEnvelope
	}
	if value.Memory == 0 || value.Memory > maxMemoryKiB || value.Time == 0 || value.Time > maxTimeCost || value.Threads == 0 || value.Threads > maxParallelism {
		return nil, errInvalidEnvelope
	}
	salt, err := base64.StdEncoding.DecodeString(value.Salt)
	if err != nil || len(salt) != saltBytes {
		return nil, errInvalidEnvelope
	}
	nonce, err := base64.StdEncoding.DecodeString(value.Nonce)
	if err != nil || len(nonce) != nonceBytes {
		return nil, errInvalidEnvelope
	}
	ciphertext, err := base64.StdEncoding.DecodeString(value.Payload)
	if err != nil || len(ciphertext) > maxCiphertextBytes {
		return nil, errInvalidEnvelope
	}
	metadata := value
	metadata.Payload = ""
	aad, err := json.Marshal(metadata)
	if err != nil {
		return nil, errInvalidEnvelope
	}
	key := deriveKey(password, salt, value.Memory, value.Time, value.Threads)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errInvalidEnvelope
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errInvalidEnvelope
	}
	plain, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errDecryptFailed
	}
	return plain, nil
}

func deriveKey(password string, salt []byte, memory, timeCost uint32, parallelism uint8) []byte {
	passwordHash := sha256.Sum256([]byte(strings.TrimSpace(password)))
	return argon2.IDKey(passwordHash[:], salt, timeCost, memory, parallelism, keyBytes)
}
