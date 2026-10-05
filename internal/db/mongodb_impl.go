//go:build gonavi_full_drivers || gonavi_mongodb_driver

package db

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MongoDB struct {
	client      *mongo.Client
	database    string
	pingTimeout time.Duration
}

var _ BatchApplierContext = (*MongoDB)(nil)

type mongoChangeCollection interface {
	DeleteOne(context.Context, interface{}, ...options.Lister[options.DeleteOneOptions]) (*mongo.DeleteResult, error)
	UpdateOne(context.Context, interface{}, interface{}, ...options.Lister[options.UpdateOneOptions]) (*mongo.UpdateResult, error)
	InsertMany(context.Context, interface{}, ...options.Lister[options.InsertManyOptions]) (*mongo.InsertManyResult, error)
}

type mongoCursorDecoder interface {
	Next(context.Context) bool
	Decode(any) error
	Err() error
}

type mongoIndexMetadata struct {
	Name   any    `bson:"name"`
	Key    bson.D `bson:"key"`
	Unique bool   `bson:"unique"`
}

type mongoProxyDialer struct {
	proxyConfig connection.ProxyConfig
}

func (d *mongoProxyDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return proxytunnel.DialContext(ctx, d.proxyConfig, network, address)
}

type mongoSSHDialer struct {
	sshConfig   connection.SSHConfig
	dialContext func(context.Context, connection.SSHConfig, string, string) (net.Conn, error)
}

func (d *mongoSSHDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return d.dialContext(ctx, d.sshConfig, network, address)
}

func mongoConnectionDialer(config connection.ConnectionConfig) options.ContextDialer {
	if config.UseSSH {
		return &mongoSSHDialer{sshConfig: config.SSH, dialContext: ssh.DialContextThroughSSH}
	}
	if config.UseProxy {
		return &mongoProxyDialer{proxyConfig: config.Proxy}
	}
	return nil
}

// mongoGetOrCreateSSHClient is kept as a narrow seam for testing the
// synchronous SSH preflight. MongoDB invokes its dialer asynchronously while
// selecting servers, which would otherwise flatten a host-key trust error into
// the driver's aggregated string error before it reaches the application.
var mongoGetOrCreateSSHClient = ssh.GetOrCreateSSHClient

const defaultMongoPort = 27017
const mongoObjectIDLocatorColumn = "__gonavi_mongodb_id_locator__"

func normalizeMongoAddress(host string, port int) string {
	h := strings.TrimSpace(host)
	if h == "" {
		h = "localhost"
	}
	p := port
	if p <= 0 {
		p = defaultMongoPort
	}
	return fmt.Sprintf("%s:%d", h, p)
}

func normalizeMongoSeed(raw string, defaultPort int, useSRV bool) (string, bool) {
	host, port, ok := parseHostPortWithDefault(raw, defaultPort)
	if !ok {
		return "", false
	}

	if useSRV {
		normalized := strings.TrimSpace(host)
		if normalized == "" {
			return "", false
		}
		return normalized, true
	}

	return normalizeMongoAddress(host, port), true
}

func collectMongoSeeds(config connection.ConnectionConfig) []string {
	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultMongoPort
	}
	useSRV := config.MongoSRV

	candidates := make([]string, 0, len(config.Hosts)+1)
	if len(config.Hosts) > 0 {
		candidates = append(candidates, config.Hosts...)
	} else {
		if useSRV {
			candidates = append(candidates, strings.TrimSpace(config.Host))
		} else {
			candidates = append(candidates, normalizeMongoAddress(config.Host, defaultPort))
		}
	}

	result := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, entry := range candidates {
		normalized, ok := normalizeMongoSeed(entry, defaultPort, useSRV)
		if !ok {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}

	return result
}
