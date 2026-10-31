//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"strings"

	"github.com/jcmturner/gokrb5/v8/client"
	krbconfig "github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/credentials"
	"github.com/jcmturner/gokrb5/v8/crypto"
	"github.com/jcmturner/gokrb5/v8/gssapi"
	"github.com/jcmturner/gokrb5/v8/iana/keyusage"
	"github.com/jcmturner/gokrb5/v8/keytab"
	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/spnego"
	"github.com/jcmturner/gokrb5/v8/types"
)

func hiveKerberosClient(cfg hiveConfig, serverName string) (*client.Client, error) {
	path := cfg.params.Get("krb5config")
	if path == "" {
		path = os.Getenv("KRB5_CONFIG")
	}
	if path == "" {
		path = "/etc/krb5.conf"
	}
	conf, err := krbconfig.Load(path)
	if err != nil {
		return nil, fmt.Errorf("load Hive Kerberos configuration: %w", err)
	}
	if err = hiveKerberosPrincipalRealm(conf, cfg.principal, serverName); err != nil {
		return nil, err
	}
	username := cfg.User
	realm := cfg.params.Get("realm")
	if user, userRealm, ok := strings.Cut(username, "@"); ok {
		username = user
		if realm == "" {
			realm = userRealm
		}
	}
	if realm == "" {
		realm = conf.LibDefaults.DefaultRealm
	}
	cachePath := cfg.params.Get("credentialcache")
	keytabPath := cfg.params.Get("keytab")
	if cachePath != "" && keytabPath != "" {
		return nil, fmt.Errorf("Hive Kerberos keytab and credential cache are mutually exclusive")
	}
	if cachePath == "" && keytabPath == "" && cfg.Password == "" {
		cachePath = os.Getenv("KRB5CCNAME")
	}
	var kerberos *client.Client
	switch {
	case cachePath != "":
		if strings.Contains(cachePath, ":") && !strings.HasPrefix(strings.ToUpper(cachePath), "FILE:") && !(len(cachePath) > 2 && cachePath[1] == ':') {
			return nil, fmt.Errorf("Hive Kerberos supports FILE credential caches only")
		}
		cachePath = strings.TrimPrefix(cachePath, "FILE:")
		cachePath = strings.TrimPrefix(cachePath, "file:")
		cache, loadErr := credentials.LoadCCache(cachePath)
		if loadErr != nil {
			return nil, fmt.Errorf("load Hive credential cache: %w", loadErr)
		}
		kerberos, err = client.NewFromCCache(cache, conf, client.DisablePAFXFAST(true))
	case username == "" || realm == "":
		return nil, fmt.Errorf("Hive Kerberos client user and realm are required")
	case keytabPath != "":
		kt, loadErr := keytab.Load(keytabPath)
		if loadErr != nil {
			return nil, fmt.Errorf("load Hive keytab: %w", loadErr)
		}
		kerberos = client.NewWithKeytab(username, realm, kt, conf, client.DisablePAFXFAST(true))
		err = kerberos.Login()
	case cfg.Password != "":
		kerberos = client.NewWithPassword(username, realm, cfg.Password, conf, client.DisablePAFXFAST(true))
		err = kerberos.Login()
	default:
		return nil, fmt.Errorf("Hive Kerberos requires a keytab, FILE credential cache, or password")
	}
	if err != nil {
		if kerberos != nil {
			kerberos.Destroy()
		}
		return nil, fmt.Errorf("Hive Kerberos login: %w", err)
	}
	return kerberos, nil
}

func hiveServicePrincipal(cfg hiveConfig, host string, httpMode bool) string {
	principal := cfg.principal
	if principal == "" {
		service := "hive"
		if httpMode {
			service = "HTTP"
		}
		principal = service + "/" + host
	}
	principal = strings.ReplaceAll(principal, "_HOST", strings.ToLower(host))
	// gokrb5 resolves the realm from krb5.conf for service-ticket lookup.
	principal, _, _ = strings.Cut(principal, "@")
	return principal
}

func hiveSASLHandshake(ctx context.Context, conn net.Conn, cfg hiveConfig, kerberos *client.Client, host string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if kerberos != nil {
		return hiveGSSAPIHandshake(ctx, conn, cfg, kerberos, host)
	}
	user, password := cfg.User, cfg.Password
	if cfg.auth == "NONE" {
		if user == "" {
			user = "anonymous"
		}
		if password == "" {
			password = "x"
		}
	} else if user == "" || password == "" {
		return fmt.Errorf("Hive password authentication requires user and password")
	}
	if strings.ContainsRune(user, 0) || strings.ContainsRune(password, 0) {
		return fmt.Errorf("Hive PLAIN credentials contain a NUL byte")
	}
	if err := hiveSendSASLContext(ctx, conn, 1, []byte("PLAIN")); err != nil {
		return err
	}
	if err := hiveSendSASLContext(ctx, conn, 2, []byte("\x00"+user+"\x00"+password)); err != nil {
		return err
	}
	status, payload, err := hiveReadSASL(conn)
	if err != nil {
		return err
	}
	if status != 5 || len(payload) != 0 {
		return fmt.Errorf("Hive PLAIN authentication rejected (SASL status %d)", status)
	}
	return nil
}

func hiveSendSASL(writer io.Writer, status byte, payload []byte) error {
	if len(payload) > 1<<20 {
		return fmt.Errorf("Hive SASL token exceeds limit")
	}
	var header [5]byte
	header[0] = status
	binary.BigEndian.PutUint32(header[1:], uint32(len(payload)))
	if err := hiveWriteAll(writer, header[:]); err != nil {
		return err
	}
	return hiveWriteAll(writer, payload)
}
func hiveReadSASL(reader io.Reader) (byte, []byte, error) {
	var header [5]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return 0, nil, err
	}
	size := binary.BigEndian.Uint32(header[1:])
	if size > 1<<20 {
		return 0, nil, fmt.Errorf("Hive SASL token exceeds limit")
	}
	payload := make([]byte, int(size))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return 0, nil, err
	}
	if header[0] != 2 && header[0] != 5 {
		return 0, nil, fmt.Errorf("Hive SASL authentication rejected (status %d)", header[0])
	}
	return header[0], payload, nil
}

func hiveGSSAPIHandshake(ctx context.Context, conn net.Conn, cfg hiveConfig, kerberos *client.Client, host string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ticket, key, err := hiveKerberosServiceTicket(cfg, kerberos, host, false)
	if err != nil {
		return fmt.Errorf("Hive Kerberos service ticket: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	token, err := spnego.NewKRB5TokenAPREQ(kerberos, ticket, key, []int{gssapi.ContextFlagMutual, gssapi.ContextFlagInteg, gssapi.ContextFlagSequence}, []int{2})
	if err != nil {
		return err
	}
	if err = token.APReq.DecryptAuthenticator(key); err != nil {
		return err
	}
	initial, err := token.Marshal()
	if err != nil {
		return err
	}
	if err = hiveSendSASLContext(ctx, conn, 1, []byte("GSSAPI")); err != nil {
		return err
	}
	if err = hiveSendSASLContext(ctx, conn, 2, initial); err != nil {
		return err
	}
	status, challenge, err := hiveReadSASL(conn)
	if err != nil {
		return err
	}
	if status != 2 {
		return fmt.Errorf("Hive GSSAPI server omitted mutual authentication")
	}
	acceptorKey, err := hiveVerifyAPRep(challenge, key, token.APReq.Authenticator)
	if err != nil {
		return err
	}
	if err = hiveSendSASLContext(ctx, conn, 2, nil); err != nil {
		return err
	}
	status, challenge, err = hiveReadSASL(conn)
	if err != nil {
		return err
	}
	if status != 2 {
		return fmt.Errorf("Hive GSSAPI server omitted security layer negotiation")
	}
	response, err := hiveGSSAPISecurityLayer(challenge, key, acceptorKey, uint64(token.APReq.Authenticator.SeqNumber))
	if err != nil {
		return err
	}
	if err = hiveSendSASLContext(ctx, conn, 2, response); err != nil {
		return err
	}
	status, challenge, err = hiveReadSASL(conn)
	if err != nil {
		return err
	}
	if status != 5 || len(challenge) != 0 {
		return fmt.Errorf("Hive GSSAPI negotiation did not complete")
	}
	return nil
}

func hiveVerifyAPRep(challenge []byte, key types.EncryptionKey, auth types.Authenticator) (types.EncryptionKey, error) {
	var token spnego.KRB5Token
	if err := token.Unmarshal(challenge); err != nil {
		return types.EncryptionKey{}, fmt.Errorf("decode Hive Kerberos AP-REP: %w", err)
	}
	if !token.IsAPRep() {
		return types.EncryptionKey{}, fmt.Errorf("Hive Kerberos server did not return AP-REP")
	}
	plaintext, err := crypto.DecryptEncPart(token.APRep.EncPart, key, keyusage.AP_REP_ENCPART)
	if err != nil {
		return types.EncryptionKey{}, fmt.Errorf("verify Hive Kerberos AP-REP: %w", err)
	}
	var part messages.EncAPRepPart
	if err = part.Unmarshal(plaintext); err != nil {
		return types.EncryptionKey{}, err
	}
	if !part.CTime.Equal(auth.CTime) || part.Cusec != auth.Cusec {
		return types.EncryptionKey{}, fmt.Errorf("Hive Kerberos AP-REP authenticator mismatch")
	}
	return part.Subkey, nil
}

func hiveGSSAPISecurityLayer(challenge []byte, key, acceptorKey types.EncryptionKey, sequence uint64) ([]byte, error) {
	if len(challenge) < 16 {
		return nil, fmt.Errorf("truncated Hive GSSAPI security token")
	}
	// RFC 4121 tokens can rotate their body; gokrb5's parser expects an unrotated token.
	rotated := int(binary.BigEndian.Uint16(challenge[6:8]))
	if rotated != 0 {
		body := challenge[16:]
		if len(body) == 0 {
			return nil, fmt.Errorf("empty Hive GSSAPI wrap token")
		}
		rotated %= len(body)
		normalized := append([]byte(nil), challenge[:16]...)
		normalized[6], normalized[7] = 0, 0
		normalized = append(normalized, body[rotated:]...)
		normalized = append(normalized, body[:rotated]...)
		challenge = normalized
	}
	var token gssapi.WrapToken
	if err := token.Unmarshal(challenge, true); err != nil {
		return nil, err
	}
	if token.Flags&2 != 0 {
		return nil, fmt.Errorf("Hive GSSAPI encrypted security tokens are not supported")
	}
	usesSubkey := token.Flags&4 != 0
	if usesSubkey {
		if len(acceptorKey.KeyValue) == 0 {
			return nil, fmt.Errorf("Hive GSSAPI acceptor subkey is missing")
		}
		key = acceptorKey
	}
	valid, err := token.Verify(key, keyusage.GSSAPI_ACCEPTOR_SEAL)
	if err != nil {
		return nil, err
	}
	if !valid || len(token.Payload) != 4 || token.Payload[0]&1 == 0 {
		return nil, fmt.Errorf("Hive server does not offer verified SASL auth-only QOP")
	}
	response, err := gssapi.NewInitiatorWrapToken([]byte{1, 0, 0, 0}, key)
	if err != nil {
		return nil, err
	}
	response.SndSeqNum = sequence
	if usesSubkey {
		response.Flags |= 4
	}
	response.CheckSum = nil // NewInitiatorWrapToken computed it before sequence/subkey flags changed.
	if err = response.SetCheckSum(key, keyusage.GSSAPI_INITIATOR_SEAL); err != nil {
		return nil, err
	}
	return response.Marshal()
}

func hiveSendSASLContext(ctx context.Context, writer io.Writer, status byte, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return hiveSendSASL(writer, status, payload)
}
