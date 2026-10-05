package db

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gorilla/websocket"
)

func newPahoMQTTRuntime(config connection.ConnectionConfig) (mqttRuntime, error) {
	brokers, err := mqttBrokerAddresses(config)
	if err != nil {
		return nil, err
	}
	timeout := getConnectTimeout(config)
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	transport := mqttTransportScheme(config)
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return nil, err
	}

	options := pahomqtt.NewClientOptions().
		SetClientID(mqttClientID(config)).
		SetCleanSession(mqttCleanSession(config)).
		SetOrderMatters(true).
		SetAutoReconnect(false).
		SetConnectRetry(false).
		SetConnectTimeout(timeout).
		SetWriteTimeout(timeout)

	if user := strings.TrimSpace(config.User); user != "" {
		options.SetUsername(user)
		options.SetPassword(config.Password)
	}
	if transport == "ssl" || transport == "wss" {
		options.SetTLSConfig(tlsConfig)
	}
	for _, broker := range brokers {
		options.AddBroker(fmt.Sprintf("%s://%s", transport, broker))
	}
	if config.UseProxy {
		options.SetCustomOpenConnectionFn(mqttProxyOpenConnectionFn(config.Proxy, timeout, tlsConfig))
	}

	client := pahomqtt.NewClient(options)
	token := client.Connect()
	if !token.WaitTimeout(timeout + 5*time.Second) {
		return nil, localizedDatabaseRuntimeError("db.backend.error.mqtt_connect_timeout", nil)
	}
	if err := token.Error(); err != nil {
		return nil, err
	}
	runtime := &pahoMQTTRuntime{
		client:        client,
		timeout:       timeout,
		subscriptions: make(map[string]*mqttSharedSubscription),
	}
	if err := runtime.subscribeConfiguredTopics(client, config); err != nil {
		_ = runtime.Close()
		return nil, err
	}
	return runtime, nil
}

func mqttProxyOpenConnectionFn(proxyConfig connection.ProxyConfig, timeout time.Duration, tlsConfig *tls.Config) func(uri *url.URL, options pahomqtt.ClientOptions) (net.Conn, error) {
	return func(uri *url.URL, options pahomqtt.ClientOptions) (net.Conn, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		if uri.Scheme == "ws" || uri.Scheme == "wss" {
			return mqttProxyOpenWebSocket(ctx, proxyConfig, uri, options, timeout, tlsConfig)
		}

		conn, err := proxytunnel.DialContext(ctx, proxyConfig, "tcp", uri.Host)
		if err != nil {
			return nil, err
		}
		if uri.Scheme != "ssl" && uri.Scheme != "wss" {
			return conn, nil
		}

		effectiveTLS := tlsConfig
		if effectiveTLS == nil {
			effectiveTLS = options.TLSConfig
		}
		if effectiveTLS == nil {
			effectiveTLS = &tls.Config{}
		}
		cloned := effectiveTLS.Clone()
		if cloned.ServerName == "" {
			host, _, splitErr := net.SplitHostPort(uri.Host)
			if splitErr == nil {
				cloned.ServerName = host
			} else {
				cloned.ServerName = uri.Host
			}
		}

		tlsConn := tls.Client(conn, cloned)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}
}

func mqttProxyOpenWebSocket(ctx context.Context, proxyConfig connection.ProxyConfig, uri *url.URL, options pahomqtt.ClientOptions, timeout time.Duration, tlsConfig *tls.Config) (net.Conn, error) {
	dialURI := *uri
	dialURI.User = nil

	websocketOptions := options.WebsocketOptions
	dialer := websocket.Dialer{
		NetDialContext: func(dialCtx context.Context, network, address string) (net.Conn, error) {
			return proxytunnel.DialContext(dialCtx, proxyConfig, network, address)
		},
		HandshakeTimeout:  timeout,
		TLSClientConfig:   tlsConfig,
		Subprotocols:      []string{"mqtt"},
		EnableCompression: false,
	}
	if dialer.TLSClientConfig == nil {
		dialer.TLSClientConfig = options.TLSConfig
	}
	if websocketOptions != nil {
		dialer.ReadBufferSize = websocketOptions.ReadBufferSize
		dialer.WriteBufferSize = websocketOptions.WriteBufferSize
	}

	ws, response, err := dialer.DialContext(ctx, dialURI.String(), options.HTTPHeaders)
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, err
	}
	return &mqttWebSocketConn{Conn: ws}, nil
}

type mqttWebSocketConn struct {
	*websocket.Conn
	reader  io.Reader
	readMu  sync.Mutex
	writeMu sync.Mutex
}

func (c *mqttWebSocketConn) SetDeadline(deadline time.Time) error {
	if err := c.SetReadDeadline(deadline); err != nil {
		return err
	}
	return c.SetWriteDeadline(deadline)
}

func (c *mqttWebSocketConn) Write(payload []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.WriteMessage(websocket.BinaryMessage, payload); err != nil {
		return 0, err
	}
	return len(payload), nil
}

func (c *mqttWebSocketConn) Read(buffer []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	for {
		if c.reader == nil {
			_, reader, err := c.NextReader()
			if err != nil {
				return 0, err
			}
			c.reader = reader
		}
		n, err := c.reader.Read(buffer)
		if err != io.EOF {
			return n, err
		}
		c.reader = nil
		if n > 0 {
			return n, nil
		}
	}
}
