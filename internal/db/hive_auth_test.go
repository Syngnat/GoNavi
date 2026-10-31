//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/jcmturner/gokrb5/v8/crypto"
	"github.com/jcmturner/gokrb5/v8/gssapi"
	"github.com/jcmturner/gokrb5/v8/iana/keyusage"
	"github.com/jcmturner/gokrb5/v8/types"
)

func TestHiveGSSAPISecurityLayer(t *testing.T) {
	key := types.EncryptionKey{KeyType: 17, KeyValue: bytes.Repeat([]byte{1}, 16)}
	acceptorKey := types.EncryptionKey{KeyType: 17, KeyValue: bytes.Repeat([]byte{2}, 16)}
	for _, subkey := range []bool{false, true} {
		for _, rotate := range []bool{false, true} {
			name := "session"
			selected := key
			flags := byte(1)
			if subkey {
				name = "subkey"
				selected = acceptorKey
				flags |= 4
			}
			if rotate {
				name += "/rotated"
			}
			t.Run(name, func(t *testing.T) {
				enctype, err := crypto.GetEtype(selected.KeyType)
				if err != nil {
					t.Fatal(err)
				}
				offer := gssapi.WrapToken{Flags: flags, EC: uint16(enctype.GetHMACBitLength() / 8), Payload: []byte{7, 0, 0, 0}, SndSeqNum: 0}
				if err = offer.SetCheckSum(selected, keyusage.GSSAPI_ACCEPTOR_SEAL); err != nil {
					t.Fatal(err)
				}
				raw, err := offer.Marshal()
				if err != nil {
					t.Fatal(err)
				}
				if rotate {
					body := append([]byte(nil), raw[16:]...)
					rotation := 4
					copy(raw[16:], append(body[len(body)-rotation:], body[:len(body)-rotation]...))
					binary.BigEndian.PutUint16(raw[6:8], uint16(rotation))
				}
				reply, err := hiveGSSAPISecurityLayer(raw, key, acceptorKey, 42)
				if err != nil {
					t.Fatal(err)
				}
				var token gssapi.WrapToken
				if err = token.Unmarshal(reply, false); err != nil {
					t.Fatal(err)
				}
				valid, err := token.Verify(selected, keyusage.GSSAPI_INITIATOR_SEAL)
				if err != nil || !valid || token.SndSeqNum != 42 || !bytes.Equal(token.Payload, []byte{1, 0, 0, 0}) {
					t.Fatalf("security reply=%+v verified=%v err=%v", token, valid, err)
				}
				raw[len(raw)-1] ^= 1
				if _, err = hiveGSSAPISecurityLayer(raw, key, acceptorKey, 0); err == nil {
					t.Fatal("tampered server wrap accepted")
				}
			})
		}
	}
	offer := gssapi.WrapToken{Flags: 1, EC: 12, Payload: []byte{2, 0, 0, 0}}
	if err := offer.SetCheckSum(key, keyusage.GSSAPI_ACCEPTOR_SEAL); err != nil {
		t.Fatal(err)
	}
	raw, err := offer.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = hiveGSSAPISecurityLayer(raw, key, types.EncryptionKey{}, 0); err == nil {
		t.Fatal("server requiring auth-int was accepted")
	}
}
