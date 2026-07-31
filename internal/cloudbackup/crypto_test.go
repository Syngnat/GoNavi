package cloudbackup

import (
	"bytes"
	"testing"
)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	plain := []byte(`{"schemaVersion":1,"connections":[{"name":"prod"}]}`)
	ciphertext, err := Encrypt(plain, "correct horse battery staple")
	if err != nil {
		t.Fatalf("Encrypt returned error: %v", err)
	}
	if bytes.Contains(ciphertext, plain) {
		t.Fatal("encrypted envelope contains plaintext payload")
	}
	decoded, err := Decrypt(ciphertext, "correct horse battery staple")
	if err != nil {
		t.Fatalf("Decrypt returned error: %v", err)
	}
	if !bytes.Equal(decoded, plain) {
		t.Fatalf("round trip mismatch: got %q want %q", decoded, plain)
	}
}

func TestDecryptRejectsWrongPasswordAndTampering(t *testing.T) {
	ciphertext, err := Encrypt([]byte("secret"), "password")
	if err != nil {
		t.Fatalf("Encrypt returned error: %v", err)
	}
	if _, err := Decrypt(ciphertext, "wrong"); err == nil {
		t.Fatal("wrong password should fail")
	}
	ciphertext[len(ciphertext)-2] ^= 1
	if _, err := Decrypt(ciphertext, "password"); err == nil {
		t.Fatal("tampered envelope should fail")
	}
}

func TestEncryptRequiresPassword(t *testing.T) {
	if _, err := Encrypt([]byte("payload"), " "); err == nil {
		t.Fatal("empty password should fail")
	}
}
