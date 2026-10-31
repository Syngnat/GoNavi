//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"time"

	proxytunnel "GoNavi-Wails/internal/proxy"

	"github.com/apache/thrift/lib/go/thrift"
	hs "github.com/beltran/gohive/hiveserver"
	"github.com/jcmturner/gokrb5/v8/client"
	"github.com/jcmturner/gokrb5/v8/spnego"
)

const hiveMaxMessageBytes = 64 << 20

type hiveWire struct {
	transport thrift.TTransport
	api       hs.TCLIService
	conn      net.Conn
	http      *http.Transport
	kerberos  *client.Client
}

func openHiveWire(ctx context.Context, cfg hiveConfig, serverName string) (wire *hiveWire, resultErr error) {
	wire = &hiveWire{}
	if err := ctx.Err(); err != nil {
		return wire, err
	}
	defer func() {
		if resultErr != nil {
			wire.close()
		}
	}()
	tlsConfig, err := resolveGenericTLSConfig(cfg.ConnectionConfig)
	if err != nil {
		return wire, err
	}
	if tlsConfig != nil {
		tlsConfig.ServerName = serverName
		tlsConfig.MinVersion = tls.VersionTLS12
	}
	if cfg.auth == "KERBEROS" {
		wire.kerberos, err = hiveKerberosClient(cfg, serverName)
		if err != nil {
			return wire, err
		}
	}
	if err := ctx.Err(); err != nil {
		return wire, err
	}
	if cfg.transport == "http" {
		wire.transport, wire.http, err = newHiveHTTPTransport(cfg, serverName, tlsConfig, wire.kerberos)
	} else {
		conn, err := dialHiveEndpoint(ctx, cfg, net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
		if err != nil {
			return wire, fmt.Errorf("dial HiveServer2: %w", err)
		}
		wire.conn = conn
		if tlsConfig != nil {
			secured := tls.Client(conn, tlsConfig)
			if err = secured.HandshakeContext(ctx); err != nil {
				return wire, fmt.Errorf("Hive TLS handshake: %w", err)
			}
			wire.conn = secured
		}
		stop := watchHiveDeadline(ctx, wire.conn)
		defer stop()
		if cfg.auth != "NOSASL" {
			if err = hiveSASLHandshake(ctx, wire.conn, cfg, wire.kerberos, serverName); err != nil {
				return wire, err
			}
		}
		wire.transport = &hiveSocketTransport{conn: wire.conn, framed: cfg.auth != "NOSASL"}
	}
	if err != nil {
		return wire, err
	}
	protocol := newHiveBoundedProtocolFactory(thrift.NewTBinaryProtocolFactoryConf(&thrift.TConfiguration{MaxMessageSize: hiveMaxMessageBytes, MaxFrameSize: hiveMaxMessageBytes}))
	wire.api = hs.NewTCLIServiceClientFactory(wire.transport, protocol)
	return wire, nil
}

func dialHiveEndpoint(ctx context.Context, cfg hiveConfig, address string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, getConnectTimeout(cfg.ConnectionConfig))
	defer cancel()
	if cfg.UseProxy {
		return proxytunnel.DialContext(ctx, cfg.Proxy, "tcp", address)
	}
	return (&net.Dialer{KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", address)
}

func watchHiveDeadline(ctx context.Context, conn net.Conn) func() {
	deadline, _ := ctx.Deadline()
	conn.SetDeadline(deadline)
	finished := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { defer close(finished); conn.SetDeadline(time.Now()) })
	return func() {
		if !stop() {
			<-finished
		}
		conn.SetDeadline(time.Time{})
	}
}

func (w *hiveWire) close() error {
	var err error
	if w.transport != nil {
		err = w.transport.Close()
	} else if w.conn != nil {
		err = w.conn.Close()
	}
	if w.http != nil {
		w.http.CloseIdleConnections()
	}
	if w.kerberos != nil {
		w.kerberos.Destroy()
	}
	return err
}

// SASL frames carry plain Thrift bytes after auth-only negotiation. NOSASL is unframed.
type hiveSocketTransport struct {
	conn   net.Conn
	framed bool
	write  bytes.Buffer
	read   *bytes.Reader
}

func (t *hiveSocketTransport) Open() error            { return nil }
func (t *hiveSocketTransport) IsOpen() bool           { return t.conn != nil }
func (t *hiveSocketTransport) Close() error           { return t.conn.Close() }
func (t *hiveSocketTransport) RemainingBytes() uint64 { return ^uint64(0) }
func (t *hiveSocketTransport) Write(p []byte) (int, error) {
	if !t.framed {
		return t.conn.Write(p)
	}
	if t.write.Len()+len(p) > hiveMaxMessageBytes {
		return 0, fmt.Errorf("Hive request exceeds frame limit")
	}
	return t.write.Write(p)
}
func (t *hiveSocketTransport) Flush(ctx context.Context) error {
	if !t.framed {
		return ctx.Err()
	}
	payload := t.write.Bytes()
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if err := hiveWriteAll(t.conn, header[:]); err != nil {
		return err
	}
	if err := hiveWriteAll(t.conn, payload); err != nil {
		return err
	}
	t.write.Reset()
	return nil
}
func (t *hiveSocketTransport) Read(p []byte) (int, error) {
	if !t.framed {
		return t.conn.Read(p)
	}
	for t.read == nil || t.read.Len() == 0 {
		var header [4]byte
		if _, err := io.ReadFull(t.conn, header[:]); err != nil {
			return 0, err
		}
		size := binary.BigEndian.Uint32(header[:])
		if size == 0 || size > hiveMaxMessageBytes {
			return 0, fmt.Errorf("invalid Hive SASL frame size")
		}
		payload := make([]byte, int(size))
		if _, err := io.ReadFull(t.conn, payload); err != nil {
			return 0, err
		}
		t.read = bytes.NewReader(payload)
	}
	return t.read.Read(p)
}
func hiveWriteAll(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		n, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		payload = payload[n:]
	}
	return nil
}

type hiveHTTPTransport struct {
	client     *http.Client
	endpoint   string
	cfg        hiveConfig
	spn        string
	serverName string
	kerberos   *client.Client
	request    bytes.Buffer
	response   io.ReadCloser
	remaining  int64
}

func newHiveHTTPTransport(cfg hiveConfig, serverName string, tlsConfig *tls.Config, kerberos *client.Client) (thrift.TTransport, *http.Transport, error) {
	transport := &http.Transport{TLSClientConfig: tlsConfig, TLSHandshakeTimeout: getConnectTimeout(cfg.ConnectionConfig), IdleConnTimeout: 90 * time.Second, MaxIdleConns: 4, MaxIdleConnsPerHost: 2}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if cfg.dialAddress != "" {
			address = cfg.dialAddress
		}
		return dialHiveEndpoint(ctx, cfg, address)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, nil, err
	}
	httpClient := &http.Client{Transport: transport, Jar: jar, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	scheme := "http"
	if tlsConfig != nil {
		scheme = "https"
	}
	authority := cfg.authority
	if authority == "" {
		authority = net.JoinHostPort(serverName, strconv.Itoa(cfg.Port))
	}
	endpoint := url.URL{Scheme: scheme, Host: authority, Path: "/" + strings.TrimPrefix(cfg.httpPath, "/")}
	return &hiveHTTPTransport{client: httpClient, endpoint: endpoint.String(), cfg: cfg, kerberos: kerberos, spn: hiveServicePrincipal(cfg, serverName, true), serverName: serverName}, transport, nil
}
func (t *hiveHTTPTransport) Open() error  { return nil }
func (t *hiveHTTPTransport) IsOpen() bool { return true }
func (t *hiveHTTPTransport) RemainingBytes() uint64 {
	if t.remaining < 0 {
		return 0
	}
	return uint64(t.remaining)
}
func (t *hiveHTTPTransport) Close() error {
	if t.response != nil {
		err := t.response.Close()
		t.response = nil
		return err
	}
	return nil
}
func (t *hiveHTTPTransport) Write(p []byte) (int, error) {
	if t.request.Len()+len(p) > hiveMaxMessageBytes {
		return 0, fmt.Errorf("Hive HTTP request exceeds limit")
	}
	return t.request.Write(p)
}
func (t *hiveHTTPTransport) Read(p []byte) (int, error) {
	if t.response == nil {
		return 0, io.EOF
	}
	if t.remaining <= 0 {
		return 0, fmt.Errorf("Hive HTTP response exceeds limit")
	}
	if int64(len(p)) > t.remaining {
		p = p[:t.remaining]
	}
	n, err := t.response.Read(p)
	t.remaining -= int64(n)
	return n, err
}
func (t *hiveHTTPTransport) Flush(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := t.Close(); err != nil {
		return err
	}
	payload := append([]byte(nil), t.request.Bytes()...)
	t.request.Reset()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-thrift")
	req.Header.Set("User-Agent", "GoNavi-HiveServer2")
	if t.kerberos != nil {
		if _, _, err = hiveKerberosServiceTicket(t.cfg, t.kerberos, t.serverName, true); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err = spnego.SetSPNEGOHeader(t.kerberos, req, t.spn); err != nil {
			return fmt.Errorf("Hive HTTP Kerberos authentication: %w", err)
		}
	} else if t.cfg.auth != "NOSASL" {
		user := t.cfg.User
		if user == "" {
			user = "anonymous"
		}
		req.SetBasicAuth(user, t.cfg.Password)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	response, err := t.client.Do(req)
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return fmt.Errorf("Hive HTTP server returned status %d", response.StatusCode)
	}
	if response.ContentLength > hiveMaxMessageBytes {
		response.Body.Close()
		return fmt.Errorf("Hive HTTP response exceeds limit")
	}
	t.response = response.Body
	t.remaining = hiveMaxMessageBytes
	return nil
}
