package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const (
	savedQueryFingerprintVersion = "connection-v1"
	savedQueryBindingActive      = "active"
	savedQueryBindingRebound     = "rebound"
	savedQueryBindingOrphan      = "orphan"
)

type savedQueryConnectionFingerprintPayload struct {
	Version            string   `json:"version"`
	Type               string   `json:"type"`
	Driver             string   `json:"driver,omitempty"`
	Host               string   `json:"host,omitempty"`
	Port               int      `json:"port,omitempty"`
	Hosts              []string `json:"hosts,omitempty"`
	User               string   `json:"user,omitempty"`
	Database           string   `json:"database,omitempty"`
	UseSSL             bool     `json:"useSSL,omitempty"`
	SSLMode            string   `json:"sslMode,omitempty"`
	UseSSH             bool     `json:"useSSH,omitempty"`
	SSHHost            string   `json:"sshHost,omitempty"`
	SSHPort            int      `json:"sshPort,omitempty"`
	SSHUser            string   `json:"sshUser,omitempty"`
	UseHTTPTunnel      bool     `json:"useHttpTunnel,omitempty"`
	HTTPTunnelHost     string   `json:"httpTunnelHost,omitempty"`
	HTTPTunnelPort     int      `json:"httpTunnelPort,omitempty"`
	HTTPTunnelUser     string   `json:"httpTunnelUser,omitempty"`
	HTTPTunnelBase64   *bool    `json:"httpTunnelEncodeBase64,omitempty"`
	ClickHouseProtocol string   `json:"clickHouseProtocol,omitempty"`
	OceanBaseProtocol  string   `json:"oceanBaseProtocol,omitempty"`
	Topology           string   `json:"topology,omitempty"`
	ReplicaSet         string   `json:"replicaSet,omitempty"`
	AuthSource         string   `json:"authSource,omitempty"`
	ReadPreference     string   `json:"readPreference,omitempty"`
	MongoSRV           bool     `json:"mongoSrv,omitempty"`
	MongoAuthMechanism string   `json:"mongoAuthMechanism,omitempty"`
	RedisMaster        string   `json:"redisMaster,omitempty"`
	RedisUser          string   `json:"redisUser,omitempty"`
	MySQLReplicaUser   string   `json:"mysqlReplicaUser,omitempty"`
	MongoReplicaUser   string   `json:"mongoReplicaUser,omitempty"`
}

func normalizeFingerprintText(value string) string {
	return strings.TrimSpace(value)
}

func normalizeFingerprintLower(value string) string {
	return strings.ToLower(normalizeFingerprintText(value))
}

func normalizeFingerprintHosts(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		host := normalizeFingerprintLower(value)
		if host == "" {
			continue
		}
		if _, exists := seen[host]; exists {
			continue
		}
		seen[host] = struct{}{}
		result = append(result, host)
	}
	sort.Strings(result)
	return result
}

func buildConnectionFingerprint(config connection.ConnectionConfig) (string, bool) {
	payload := savedQueryConnectionFingerprintPayload{
		Version:            savedQueryFingerprintVersion,
		Type:               normalizeFingerprintLower(config.Type),
		Driver:             normalizeFingerprintLower(config.Driver),
		Host:               normalizeFingerprintLower(config.Host),
		Port:               config.Port,
		Hosts:              normalizeFingerprintHosts(config.Hosts),
		User:               normalizeFingerprintText(config.User),
		Database:           normalizeFingerprintText(config.Database),
		UseSSL:             config.UseSSL,
		SSLMode:            normalizeFingerprintLower(config.SSLMode),
		UseSSH:             config.UseSSH,
		SSHHost:            normalizeFingerprintLower(config.SSH.Host),
		SSHPort:            config.SSH.Port,
		SSHUser:            normalizeFingerprintText(config.SSH.User),
		UseHTTPTunnel:      config.UseHTTPTunnel,
		HTTPTunnelHost:     normalizeFingerprintLower(config.HTTPTunnel.Host),
		HTTPTunnelPort:     config.HTTPTunnel.Port,
		HTTPTunnelUser:     normalizeFingerprintText(config.HTTPTunnel.User),
		HTTPTunnelBase64:   config.HTTPTunnel.EncodeBase64,
		ClickHouseProtocol: normalizeFingerprintLower(config.ClickHouseProtocol),
		OceanBaseProtocol:  normalizeFingerprintLower(config.OceanBaseProtocol),
		Topology:           normalizeFingerprintLower(config.Topology),
		ReplicaSet:         normalizeFingerprintText(config.ReplicaSet),
		AuthSource:         normalizeFingerprintText(config.AuthSource),
		ReadPreference:     normalizeFingerprintLower(config.ReadPreference),
		MongoSRV:           config.MongoSRV,
		MongoAuthMechanism: normalizeFingerprintLower(config.MongoAuthMechanism),
		RedisMaster:        normalizeFingerprintText(config.RedisSentinelMaster),
		RedisUser:          normalizeFingerprintText(config.RedisSentinelUser),
		MySQLReplicaUser:   normalizeFingerprintText(config.MySQLReplicaUser),
		MongoReplicaUser:   normalizeFingerprintText(config.MongoReplicaUser),
	}
	if payload.Type == "" {
		return "", false
	}
	if payload.Host == "" && len(payload.Hosts) == 0 && payload.Database == "" {
		return "", false
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return "", false
	}
	sum := sha256.Sum256(data)
	return savedQueryFingerprintVersion + ":" + hex.EncodeToString(sum[:]), true
}

func buildSavedConnectionFingerprint(view connection.SavedConnectionView) (string, bool) {
	return buildConnectionFingerprint(view.Config)
}

func buildLegacyConnectionFingerprint(input connection.SavedConnectionInput) (string, bool) {
	config := input.Config
	if strings.TrimSpace(config.ID) == "" {
		config.ID = strings.TrimSpace(input.ID)
	}
	return buildConnectionFingerprint(config)
}

func indexSavedConnectionsByID(connections []connection.SavedConnectionView) map[string]connection.SavedConnectionView {
	result := make(map[string]connection.SavedConnectionView, len(connections))
	for _, item := range connections {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		result[id] = item
	}
	return result
}

func indexLegacyConnectionsByID(connections []connection.SavedConnectionInput) map[string]connection.SavedConnectionInput {
	result := make(map[string]connection.SavedConnectionInput, len(connections))
	for _, item := range connections {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			id = strings.TrimSpace(item.Config.ID)
		}
		if id == "" {
			continue
		}
		result[id] = item
	}
	return result
}

func indexSavedConnectionsByFingerprint(connections []connection.SavedConnectionView) map[string][]connection.SavedConnectionView {
	result := make(map[string][]connection.SavedConnectionView)
	for _, item := range connections {
		fingerprint, ok := buildSavedConnectionFingerprint(item)
		if !ok {
			continue
		}
		result[fingerprint] = append(result[fingerprint], item)
	}
	return result
}

func applySavedQueryActiveBinding(query connection.SavedQuery, current connection.SavedConnectionView) connection.SavedQuery {
	if fingerprint, ok := buildSavedConnectionFingerprint(current); ok {
		query.ConnectionFingerprint = fingerprint
		query.FingerprintVersion = savedQueryFingerprintVersion
	}
	query.BindingStatus = savedQueryBindingActive
	if strings.TrimSpace(query.OriginalConnectionID) == strings.TrimSpace(query.ConnectionID) {
		query.OriginalConnectionID = ""
	}
	return query
}

func applySavedQueryOrphanBinding(query connection.SavedQuery, originalConnectionID string, fingerprint string) connection.SavedQuery {
	if strings.TrimSpace(query.OriginalConnectionID) == "" {
		query.OriginalConnectionID = strings.TrimSpace(originalConnectionID)
	}
	if strings.TrimSpace(fingerprint) != "" {
		query.ConnectionFingerprint = fingerprint
		query.FingerprintVersion = savedQueryFingerprintVersion
	}
	query.BindingStatus = savedQueryBindingOrphan
	return query
}

func rebindSavedQueryByFingerprint(
	query connection.SavedQuery,
	connectionID string,
	fingerprint string,
	currentByFingerprint map[string][]connection.SavedConnectionView,
) (connection.SavedQuery, bool) {
	fingerprint = strings.TrimSpace(fingerprint)
	if fingerprint == "" {
		return query, false
	}

	matches := currentByFingerprint[fingerprint]
	if len(matches) != 1 {
		return applySavedQueryOrphanBinding(query, connectionID, fingerprint), true
	}

	if strings.TrimSpace(query.OriginalConnectionID) == "" {
		query.OriginalConnectionID = connectionID
	}
	query.ConnectionID = matches[0].ID
	query.ConnectionFingerprint = fingerprint
	query.FingerprintVersion = savedQueryFingerprintVersion
	query.BindingStatus = savedQueryBindingRebound
	return query, true
}

func resolveSavedQueryBinding(
	query connection.SavedQuery,
	currentByID map[string]connection.SavedConnectionView,
	currentByFingerprint map[string][]connection.SavedConnectionView,
	legacyByID map[string]connection.SavedConnectionInput,
) connection.SavedQuery {
	connectionID := strings.TrimSpace(query.ConnectionID)
	if current, found := currentByID[connectionID]; found {
		return applySavedQueryActiveBinding(query, current)
	}

	if rebound, resolved := rebindSavedQueryByFingerprint(query, connectionID, query.ConnectionFingerprint, currentByFingerprint); resolved {
		return rebound
	}

	legacy, found := legacyByID[connectionID]
	if !found {
		return applySavedQueryOrphanBinding(query, connectionID, query.ConnectionFingerprint)
	}

	fingerprint, ok := buildLegacyConnectionFingerprint(legacy)
	if !ok {
		return applySavedQueryOrphanBinding(query, connectionID, query.ConnectionFingerprint)
	}

	rebound, _ := rebindSavedQueryByFingerprint(query, connectionID, fingerprint, currentByFingerprint)
	return rebound
}

func resolveSavedQueryBindings(
	queries []connection.SavedQuery,
	currentConnections []connection.SavedConnectionView,
	legacyConnections []connection.SavedConnectionInput,
) []connection.SavedQuery {
	currentByID := indexSavedConnectionsByID(currentConnections)
	currentByFingerprint := indexSavedConnectionsByFingerprint(currentConnections)
	legacyByID := indexLegacyConnectionsByID(legacyConnections)

	result := make([]connection.SavedQuery, 0, len(queries))
	for _, query := range queries {
		result = append(result, resolveSavedQueryBinding(query, currentByID, currentByFingerprint, legacyByID))
	}
	return result
}
