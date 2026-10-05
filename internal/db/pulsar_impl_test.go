//go:build gonavi_full_drivers || gonavi_pulsar_driver

package db

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	"github.com/apache/pulsar-client-go/pulsar"
)

func TestPulsarSQL(t *testing.T) {
	for _, tc := range []struct {
		query string
		valid bool
	}{
		{"SHOW TOPICS; ", true},
		{"SHOW TOPICS LIMIT 100", true},
		{"SHOW TOPICS LIMIT -1", false},
		{"SELECT * FROM \"persistent://public/default/orders\" LIMIT 10", true},
		{"CONSUME FROM orders EARLIEST LIMIT 100", true},
		{"CONSUME FROM orders LATEST LIMIT 1", true},
		{"SELECT * FROM", false}, {"SELECT * FROM orders LIMIT", false},
		{"SELECT * FROM orders LIMIT abc", false}, {"SELECT * FROM orders LIMIT -1", false},
		{"SELECT * FROM orders LIMIT 1001", false}, {"SELECT * FROM orders WHERE id=1", false},
		{"SELECT count(*) FROM orders", false}, {"SELECT * FROM orders; DELETE FROM orders", false},
	} {
		t.Run(tc.query, func(t *testing.T) {
			_, ok := parsePulsarSQL(tc.query)
			if ok != tc.valid {
				t.Fatalf("valid=%v, want %v", ok, tc.valid)
			}
		})
	}
}

func TestPulsarConfigURI(t *testing.T) {
	cfg := normalizePulsarConfig(connection.ConnectionConfig{
		URI:              "pulsar+ssl://alice:secret@[::1]/persistent%3A%2F%2Fpublic%2Fdefault%2Forders?token=old",
		ConnectionParams: "token=new", SSLCAPath: "root.pem",
	})
	if cfg.serviceURL != "pulsar+ssl://[::1]:6651" || cfg.token != "new" || cfg.caPath != "root.pem" || cfg.topic != "persistent://public/default/orders" {
		t.Fatalf("URI, TLS, CA or parameter precedence mismatch")
	}
}

type pulsarClientProbe struct {
	pulsar.Client
	reader   pulsar.Reader
	producer pulsar.Producer
	err      error
	topic    string
}

func (p *pulsarClientProbe) TopicPartitions(topic string) ([]string, error) {
	p.topic = topic
	return nil, p.err
}
func (p *pulsarClientProbe) CreateReader(pulsar.ReaderOptions) (pulsar.Reader, error) {
	return p.reader, p.err
}
func (p *pulsarClientProbe) CreateProducer(pulsar.ProducerOptions) (pulsar.Producer, error) {
	return p.producer, p.err
}

type pulsarProducerProbe struct {
	pulsar.Producer
	message *pulsar.ProducerMessage
	closed  bool
}

func (p *pulsarProducerProbe) Send(_ context.Context, message *pulsar.ProducerMessage) (pulsar.MessageID, error) {
	p.message = message
	return pulsar.EarliestMessageID(), nil
}
func (p *pulsarProducerProbe) Close() { p.closed = true }

func TestPulsarPublish(t *testing.T) {
	for _, tc := range []struct{ command, payload string }{
		{`{"publish":"orders","value":{"id":9007199254740993},"key":"k","properties":{"source":"test"}}`, `{"id":9007199254740993}`},
		{`{"publish":"orders","value":"hello","key":"k","properties":{"source":"test"}}`, "hello"},
		{`{"publish":"orders","value":null,"key":"k","properties":{"source":"test"}}`, "null"},
	} {
		t.Run(tc.payload, func(t *testing.T) {
			producer := &pulsarProducerProbe{}
			p := &PulsarDB{client: &pulsarClientProbe{producer: producer}}
			count, err := p.Exec(tc.command)
			if err != nil || count != 1 || !producer.closed {
				t.Fatalf("publish/cleanup: %d %v", count, err)
			}
			if string(producer.message.Payload) != tc.payload || producer.message.Key != "k" || producer.message.Properties["source"] != "test" {
				t.Fatalf("message mismatch: %#v", producer.message)
			}
		})
	}
}

func TestPulsarConnectDoesNotReportSuccessForUnavailableBroker(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	p := &PulsarDB{}
	if err := p.Connect(connection.ConnectionConfig{Host: "127.0.0.1", Port: port, Database: "orders", Timeout: 1}); err == nil {
		_ = p.Close()
		t.Fatal("unreachable broker passed connection test")
	}
	if p.client != nil {
		t.Fatal("failed connection leaked a client")
	}
}

func TestPulsarConnectWithoutDefaultTopicProbesBroker(t *testing.T) {
	admin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer admin.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	p := &PulsarDB{}
	err = p.Connect(connection.ConnectionConfig{
		Host: "127.0.0.1", Port: port, Timeout: 1,
		ConnectionParams: "admin_url=" + url.QueryEscape(admin.URL),
	})
	if err == nil {
		_ = p.Close()
		t.Fatal("admin availability must not hide an unavailable broker")
	}
	if p.client != nil {
		t.Fatal("failed connection leaked a client")
	}
}

func TestPulsarPingWithoutDefaultTopicChecksBrokerAndAdmin(t *testing.T) {
	client := &pulsarClientProbe{err: pulsar.ErrTopicNotfound}
	adminChecked := false
	p := &PulsarDB{
		client: client, probeTopic: "persistent://public/default/__gonavi_connection_probe__",
		listTopics: func(context.Context) ([]string, error) {
			adminChecked = true
			return []string{}, nil
		},
	}
	if err := p.Ping(); err != nil || !adminChecked || client.topic != p.probeTopic {
		t.Fatalf("broker/Admin probe: topic=%q adminChecked=%v err=%v", client.topic, adminChecked, err)
	}
	client.err = errors.New("TopicNotFound: topic does not exist")
	adminChecked = false
	if err := p.Ping(); err != nil || !adminChecked {
		t.Fatalf("ordinary TopicNotFound response should permit Admin probe: adminChecked=%v err=%v", adminChecked, err)
	}
	client.err = errors.New("broker unreachable")
	adminChecked = false
	if err := p.Ping(); err == nil || adminChecked {
		t.Fatalf("broker failure must stop before Admin probe: adminChecked=%v err=%v", adminChecked, err)
	}
}

type pulsarReaderProbe struct {
	pulsar.Reader
	err     error
	closed  bool
	message pulsar.Message
}

func (r *pulsarReaderProbe) Next(context.Context) (pulsar.Message, error) {
	if r.message != nil {
		message := r.message
		r.message = nil
		return message, nil
	}
	return nil, r.err
}
func (r *pulsarReaderProbe) Close() { r.closed = true }

type pulsarMessageProbe struct {
	pulsar.Message
	payload []byte
}

func (m *pulsarMessageProbe) Payload() []byte               { return m.payload }
func (m *pulsarMessageProbe) Topic() string                 { return "orders" }
func (m *pulsarMessageProbe) ID() pulsar.MessageID          { return pulsar.EarliestMessageID() }
func (m *pulsarMessageProbe) PublishTime() time.Time        { return time.Unix(0, 0) }
func (m *pulsarMessageProbe) EventTime() time.Time          { return time.Unix(0, 0) }
func (m *pulsarMessageProbe) Key() string                   { return "" }
func (m *pulsarMessageProbe) Properties() map[string]string { return nil }
func (m *pulsarMessageProbe) RedeliveryCount() uint32       { return 0 }

func TestPulsarPreviewBinaryPayloadSurvivesJSONTransport(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload []byte
	}{
		{name: "binary", payload: []byte{0x00, 0xff, 0xfe, 0x80, 0x61}},
		{name: "invalid UTF-8 in JSON string", payload: []byte{'"', 0xff, '"'}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader := &pulsarReaderProbe{message: &pulsarMessageProbe{payload: tc.payload}}
			p := &PulsarDB{client: &pulsarClientProbe{reader: reader}}
			rows, columns, err := p.QueryContext(context.Background(), "SELECT * FROM orders LIMIT 1")
			if err != nil || len(rows) != 1 || !reader.closed {
				t.Fatalf("preview and cleanup: rows=%v closed=%v err=%v", rows, reader.closed, err)
			}
			if rows[0]["payload_encoding"] != "base64" || !containsString(columns, "payload_encoding") {
				t.Fatalf("missing binary encoding marker: rows=%v columns=%v", rows, columns)
			}
			transport, err := json.Marshal(rows)
			if err != nil {
				t.Fatal(err)
			}
			var received []map[string]interface{}
			if err := json.Unmarshal(transport, &received); err != nil {
				t.Fatal(err)
			}
			encoded, ok := received[0]["value"].(string)
			if !ok {
				t.Fatalf("binary preview value is not a string: %#v", received[0]["value"])
			}
			restored, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil || !bytes.Equal(restored, tc.payload) {
				t.Fatalf("binary payload changed through JSON transport: got=%x want=%x err=%v", restored, tc.payload, err)
			}
			definitions, err := p.GetColumns("topics", "orders")
			if err != nil {
				t.Fatal(err)
			}
			for _, definition := range definitions {
				if definition.Name == "payload_encoding" {
					return
				}
			}
			t.Fatal("column metadata is missing payload_encoding")
		})
	}
}

func TestPulsarPreviewEmptyAndErrors(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		wantErr bool
	}{
		{"idle", context.DeadlineExceeded, false},
		{"broker failure", errors.New("broker failed"), true},
		{"cancel", context.Canceled, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader := &pulsarReaderProbe{err: tc.err}
			p := &PulsarDB{client: &pulsarClientProbe{reader: reader}}
			rows, _, err := p.QueryContext(context.Background(), "SELECT * FROM orders LIMIT 10")
			if (err != nil) != tc.wantErr || len(rows) != 0 || !reader.closed {
				t.Fatalf("unexpected rows/error/cleanup: %v %v %v", rows, err, reader.closed)
			}
		})
	}
}

func TestPulsarMetadataFailure(t *testing.T) {
	p := &PulsarDB{client: &pulsarClientProbe{err: errors.New("denied")}, defaultTopic: "orders"}
	if _, _, err := p.Query("SHOW TOPICS"); err == nil {
		t.Fatal("metadata failure must not become a zero partition count")
	}
}

func TestPulsarShowTopicsListsAllTopicsWithoutDefaultTopic(t *testing.T) {
	client := &pulsarClientProbe{}
	p := &PulsarDB{
		client: client,
		listTopics: func(context.Context) ([]string, error) {
			return []string{"persistent://public/default/orders", "persistent://public/default/users"}, nil
		},
	}
	rows, columns, err := p.Query("SHOW TOPICS LIMIT 1")
	if err != nil || len(rows) != 1 || rows[0]["topic"] != "persistent://public/default/orders" || strings.Join(columns, ",") != "topic,partition_count" {
		t.Fatalf("unexpected topic listing: rows=%#v columns=%v err=%v", rows, columns, err)
	}
}

func TestPulsarGetTablesRetainsDefaultTopicWhenAdminDiscoveryFails(t *testing.T) {
	adminErr := errors.New("admin topic listing denied")
	p := &PulsarDB{
		defaultTopic: "persistent://public/default/orders",
		listTopics: func(context.Context) ([]string, error) {
			return nil, adminErr
		},
	}
	topics, err := p.GetTables("topics")
	if !errors.Is(err, adminErr) || len(topics) != 1 || topics[0] != p.defaultTopic {
		t.Fatalf("default topic and discovery error = %v, %v", topics, err)
	}
	p.defaultTopic = ""
	topics, err = p.GetTables("topics")
	if !errors.Is(err, adminErr) || len(topics) != 0 {
		t.Fatalf("missing default topic must keep discovery failure: %v, %v", topics, err)
	}
}

func TestPulsarTopicNamespace(t *testing.T) {
	for _, tc := range []struct {
		topic, tenant, namespace string
	}{
		{"persistent://tenant/ns/orders", "tenant", "ns"},
		{"non-persistent://tenant/ns/orders", "tenant", "ns"},
		{"tenant/ns/orders", "tenant", "ns"},
		{"orders", "public", "default"},
	} {
		t.Run(tc.topic, func(t *testing.T) {
			tenant, namespace := pulsarTopicNamespace(tc.topic)
			if tenant != tc.tenant || namespace != tc.namespace {
				t.Fatalf("namespace = %s/%s, want %s/%s", tenant, namespace, tc.tenant, tc.namespace)
			}
		})
	}
}

func TestPulsarTopicListerUsesAdminEndpointAndBasicAuth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/v2/namespaces/tenant/ns/topics" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		user, password, ok := r.BasicAuth()
		if !ok || user != "alice" || password != "secret" {
			t.Fatalf("basic auth = %s/%s/%v", user, password, ok)
		}
		_, _ = w.Write([]byte(`["persistent://tenant/ns/z", "persistent://tenant/ns/a"]`))
	}))
	defer server.Close()
	lister := newPulsarTopicLister(pulsarConfig{adminURL: server.URL, tenant: "tenant", namespace: "ns", user: "alice", password: "secret"})
	topics, err := lister(context.Background())
	if err != nil || strings.Join(topics, ",") != "persistent://tenant/ns/a,persistent://tenant/ns/z" {
		t.Fatalf("topics = %v, err = %v", topics, err)
	}
}

func TestPulsarTopicListerUsesConfiguredCAAndClientCertificate(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.TLS.PeerCertificates) == 0 {
			t.Error("client certificate was not sent")
		}
		_, _ = w.Write([]byte(`["persistent://public/default/orders"]`))
	}))
	server.TLS = &tls.Config{ClientAuth: tls.RequireAnyClientCert}
	server.StartTLS()
	defer server.Close()
	certificate := server.TLS.Certificates[0]
	key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	caPath := filepath.Join(directory, "ca.pem")
	certPath := filepath.Join(directory, "client.pem")
	keyPath := filepath.Join(directory, "client-key.pem")
	for _, item := range []struct {
		path, kind string
		data       []byte
	}{
		{caPath, "CERTIFICATE", server.Certificate().Raw},
		{certPath, "CERTIFICATE", certificate.Certificate[0]},
		{keyPath, "PRIVATE KEY", key},
	} {
		if err := os.WriteFile(item.path, pem.EncodeToMemory(&pem.Block{Type: item.kind, Bytes: item.data}), 0600); err != nil {
			t.Fatal(err)
		}
	}
	lister := newPulsarTopicLister(pulsarConfig{
		adminURL: server.URL, tenant: "public", namespace: "default",
		caPath: caPath, certPath: certPath, keyPath: keyPath,
	})
	if topics, err := lister(context.Background()); err != nil || len(topics) != 1 {
		t.Fatalf("TLS admin topic listing: topics=%v err=%v", topics, err)
	}
}

func TestPulsarDecodePayloadPreservesLargeJSONNumbers(t *testing.T) {
	value, encoding := pulsarDecodePayload([]byte(`{"id":9007199254740993,"decimal":9007199254740993.0,"exponent":9.007199254740993e15,"huge":9223372036854775808,"small":7,"nested":[-9007199254740993]}`))
	if encoding != "json" {
		t.Fatalf("JSON payload encoding = %q", encoding)
	}
	object, ok := value.(map[string]interface{})
	if !ok || object["id"] != "9007199254740993" || object["decimal"] != "9007199254740993.0" || object["exponent"] != "9.007199254740993e15" || object["huge"] != "9223372036854775808" || object["nested"].([]interface{})[0] != "-9007199254740993" {
		t.Fatalf("decoded value = %#v", value)
	}
	if small, ok := object["small"].(json.Number); !ok || small != "7" {
		t.Fatalf("small number changed type or value: %T %v", object["small"], object["small"])
	}
}

func TestPulsarDecodePayloadRequiresSingleCompleteJSONValue(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		wantRaw       bool
	}{
		{name: "tail", payload: `{"a":1}tail`, wantRaw: true},
		{name: "second value", payload: `{"a":1} {"b":2}`, wantRaw: true},
		{name: "whitespace", payload: "{\"a\":1} \n\t"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			decoded, encoding := pulsarDecodePayload([]byte(tc.payload))
			if tc.wantRaw {
				if decoded != tc.payload || encoding != "text" {
					t.Fatalf("payload changed: value=%#v encoding=%q", decoded, encoding)
				}
				return
			}
			if _, ok := decoded.(map[string]interface{}); !ok || encoding != "json" {
				t.Fatalf("complete JSON was not decoded: value=%#v encoding=%q", decoded, encoding)
			}
		})
	}
}
