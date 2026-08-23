package db

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gorilla/websocket"
)

func TestMQTTWSSProxySupportsPublishAndSubscribe(t *testing.T) {
	published := make(chan []byte, 1)
	upgrader := websocket.Upgrader{
		Subprotocols: []string{"mqtt"},
		CheckOrigin:  func(*http.Request) bool { return true },
	}
	broker := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade MQTT websocket: %v", err)
			return
		}
		defer ws.Close()
		if ws.Subprotocol() != "mqtt" {
			t.Errorf("websocket subprotocol = %q, want mqtt", ws.Subprotocol())
			return
		}

		for {
			_, packet, readErr := ws.ReadMessage()
			if readErr != nil {
				return
			}
			packetType := packet[0] >> 4
			switch packetType {
			case 1: // CONNECT
				mustWriteMQTTWebSocketPacket(t, ws, []byte{0x20, 0x02, 0x00, 0x00})
			case 3: // PUBLISH
				published <- append([]byte(nil), packet...)
			case 8: // SUBSCRIBE
				packetID := mqttTestPacketID(t, packet)
				mustWriteMQTTWebSocketPacket(t, ws, []byte{0x90, 0x03, packetID[0], packetID[1], 0x00})
				mustWriteMQTTWebSocketPacket(t, ws, mqttTestPublishPacket("devices/one", []byte("proxy-message")))
			case 10: // UNSUBSCRIBE
				packetID := mqttTestPacketID(t, packet)
				mustWriteMQTTWebSocketPacket(t, ws, []byte{0xB0, 0x02, packetID[0], packetID[1]})
			case 12: // PINGREQ
				mustWriteMQTTWebSocketPacket(t, ws, []byte{0xD0, 0x00})
			case 14: // DISCONNECT
				return
			}
		}
	}))
	var serverName atomic.Value
	broker.TLS = &tls.Config{
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			serverName.Store(hello.ServerName)
			return nil, nil
		},
	}
	broker.StartTLS()
	defer broker.Close()

	proxyConfig, proxyAuthenticated := startMQTTTestHTTPConnectProxy(t)
	brokerURL, err := url.Parse(broker.URL)
	if err != nil {
		t.Fatalf("parse broker URL: %v", err)
	}
	_, portText, err := net.SplitHostPort(brokerURL.Host)
	if err != nil {
		t.Fatalf("split broker address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse broker port: %v", err)
	}

	runtime, err := newPahoMQTTRuntime(connection.ConnectionConfig{
		Type:     "mqtt",
		Host:     "localhost",
		Port:     port,
		URI:      fmt.Sprintf("wss://localhost:%d", port),
		UseSSL:   true,
		SSLMode:  "skip-verify",
		UseProxy: true,
		Proxy:    proxyConfig,
		Timeout:  2,
		Database: "devices/one",
	})
	if err != nil {
		t.Fatalf("newPahoMQTTRuntime through WSS proxy: %v", err)
	}
	defer runtime.Close()

	if _, err := runtime.Publish(context.Background(), mqttPublishCommand{
		Topic:   "devices/one",
		Payload: "sent-through-proxy",
	}); err != nil {
		t.Fatalf("Publish through WSS proxy: %v", err)
	}
	select {
	case packet := <-published:
		if !strings.Contains(string(packet), "sent-through-proxy") {
			t.Fatalf("published packet does not contain payload: %x", packet)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("broker did not receive publish through WSS proxy")
	}

	records, err := runtime.FetchMessages(context.Background(), mqttFetchRequest{
		Topic: "devices/one",
		Limit: 1,
		Wait:  time.Second,
	})
	if err != nil {
		t.Fatalf("FetchMessages through WSS proxy: %v", err)
	}
	if len(records) != 1 || string(records[0].Payload) != "proxy-message" {
		t.Fatalf("unexpected subscribed records: %#v", records)
	}
	if !proxyAuthenticated.Load() {
		t.Fatal("HTTP CONNECT proxy did not receive basic authentication")
	}
	if got, _ := serverName.Load().(string); got != "localhost" {
		t.Fatalf("TLS SNI = %q, want localhost", got)
	}
}

func TestMQTTWSProxySupportsSOCKS5(t *testing.T) {
	upgrader := websocket.Upgrader{
		Subprotocols: []string{"mqtt"},
		CheckOrigin:  func(*http.Request) bool { return true },
	}
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade MQTT websocket: %v", err)
			return
		}
		defer ws.Close()
		messageType, payload, err := ws.ReadMessage()
		if err != nil {
			t.Errorf("read MQTT websocket payload: %v", err)
			return
		}
		if messageType != websocket.BinaryMessage || string(payload) != "proxy-ping" {
			t.Errorf("unexpected MQTT websocket payload: type=%d payload=%q", messageType, payload)
			return
		}
		if err := ws.WriteMessage(websocket.BinaryMessage, []byte("proxy-pong")); err != nil {
			t.Errorf("write MQTT websocket payload: %v", err)
		}
	}))
	defer broker.Close()

	proxyConfig := startMQTTTestSOCKS5Proxy(t)
	brokerURL, err := url.Parse(strings.Replace(broker.URL, "http://", "ws://", 1))
	if err != nil {
		t.Fatalf("parse broker URL: %v", err)
	}
	options := pahomqtt.NewClientOptions().SetConnectTimeout(2 * time.Second)
	conn, err := mqttProxyOpenConnectionFn(proxyConfig, 2*time.Second, nil)(brokerURL, *options)
	if err != nil {
		t.Fatalf("open MQTT websocket through SOCKS5: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("proxy-ping")); err != nil {
		t.Fatalf("write MQTT websocket through SOCKS5: %v", err)
	}
	response := make([]byte, len("proxy-pong"))
	if _, err := io.ReadFull(conn, response); err != nil {
		t.Fatalf("read MQTT websocket through SOCKS5: %v", err)
	}
	if string(response) != "proxy-pong" {
		t.Fatalf("MQTT websocket response = %q, want proxy-pong", response)
	}
}

func startMQTTTestHTTPConnectProxy(t *testing.T) (connection.ProxyConfig, *atomic.Bool) {
	t.Helper()
	const username = "proxy-user"
	const password = "proxy-password"
	wantAuthorization := "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
	authenticated := &atomic.Bool{}

	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT required", http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get("Proxy-Authorization") != wantAuthorization {
			http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
			return
		}
		authenticated.Store(true)

		target, err := net.DialTimeout("tcp", r.Host, time.Second)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			target.Close()
			http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
			return
		}
		client, buffered, err := hijacker.Hijack()
		if err != nil {
			target.Close()
			return
		}
		if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			client.Close()
			target.Close()
			return
		}
		if err := buffered.Flush(); err != nil {
			client.Close()
			target.Close()
			return
		}

		var once sync.Once
		closeBoth := func() {
			client.Close()
			target.Close()
		}
		go func() {
			_, _ = io.Copy(target, buffered)
			once.Do(closeBoth)
		}()
		_, _ = io.Copy(client, target)
		once.Do(closeBoth)
	}))
	t.Cleanup(proxy.Close)

	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatalf("parse proxy URL: %v", err)
	}
	host, portText, err := net.SplitHostPort(proxyURL.Host)
	if err != nil {
		t.Fatalf("split proxy address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse proxy port: %v", err)
	}
	return connection.ProxyConfig{
		Type:     "http",
		Host:     host,
		Port:     port,
		User:     username,
		Password: password,
	}, authenticated
}

func startMQTTTestSOCKS5Proxy(t *testing.T) connection.ProxyConfig {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for SOCKS5 proxy: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			client, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go serveMQTTTestSOCKS5Connection(client)
		}
	}()

	host, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("split SOCKS5 proxy address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse SOCKS5 proxy port: %v", err)
	}
	return connection.ProxyConfig{Type: "socks5", Host: host, Port: port}
}

func serveMQTTTestSOCKS5Connection(client net.Conn) {
	defer client.Close()
	reader := bufio.NewReader(client)
	version, err := reader.ReadByte()
	if err != nil || version != 0x05 {
		return
	}
	methodCount, err := reader.ReadByte()
	if err != nil {
		return
	}
	methods := make([]byte, int(methodCount))
	if _, err := io.ReadFull(reader, methods); err != nil {
		return
	}
	if _, err := client.Write([]byte{0x05, 0x00}); err != nil {
		return
	}

	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil || header[0] != 0x05 || header[1] != 0x01 {
		return
	}
	var host string
	switch header[3] {
	case 0x01:
		address := make([]byte, net.IPv4len)
		if _, err := io.ReadFull(reader, address); err != nil {
			return
		}
		host = net.IP(address).String()
	case 0x03:
		length, err := reader.ReadByte()
		if err != nil {
			return
		}
		address := make([]byte, int(length))
		if _, err := io.ReadFull(reader, address); err != nil {
			return
		}
		host = string(address)
	case 0x04:
		address := make([]byte, net.IPv6len)
		if _, err := io.ReadFull(reader, address); err != nil {
			return
		}
		host = net.IP(address).String()
	default:
		return
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(reader, portBytes); err != nil {
		return
	}
	port := int(portBytes[0])<<8 | int(portBytes[1])
	target, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), time.Second)
	if err != nil {
		_, _ = client.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer target.Close()
	if _, err := client.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}

	var once sync.Once
	closeBoth := func() {
		client.Close()
		target.Close()
	}
	go func() {
		_, _ = io.Copy(target, reader)
		once.Do(closeBoth)
	}()
	_, _ = io.Copy(client, target)
	once.Do(closeBoth)
}

func mqttTestPacketID(t *testing.T, packet []byte) [2]byte {
	t.Helper()
	index := 1
	for {
		if index >= len(packet) {
			t.Fatalf("invalid MQTT packet: %x", packet)
		}
		encoded := packet[index]
		index++
		if encoded&0x80 == 0 {
			break
		}
	}
	if index+1 >= len(packet) {
		t.Fatalf("MQTT packet has no packet identifier: %x", packet)
	}
	return [2]byte{packet[index], packet[index+1]}
}

func mqttTestPublishPacket(topic string, payload []byte) []byte {
	remaining := 2 + len(topic) + len(payload)
	packet := []byte{0x30}
	for {
		encoded := byte(remaining % 128)
		remaining /= 128
		if remaining > 0 {
			encoded |= 0x80
		}
		packet = append(packet, encoded)
		if remaining == 0 {
			break
		}
	}
	packet = append(packet, byte(len(topic)>>8), byte(len(topic)))
	packet = append(packet, topic...)
	return append(packet, payload...)
}

func mustWriteMQTTWebSocketPacket(t *testing.T, ws *websocket.Conn, packet []byte) {
	t.Helper()
	if err := ws.WriteMessage(websocket.BinaryMessage, packet); err != nil {
		t.Errorf("write MQTT websocket packet: %v", err)
	}
}
