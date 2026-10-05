package db

import (
	"net/http"
	"time"

	"GoNavi-Wails/internal/ssh"
)

const (
	defaultRabbitMQPort         = 15672
	defaultRabbitMQQueryTimeout = 30 * time.Second
	defaultRabbitMQPreviewLimit = 100
	defaultRabbitMQPageSize     = 200
	maxRabbitMQPageSize         = 500
	rabbitMQDefaultVHost        = "/"
)

type RabbitMQDB struct {
	client          *http.Client
	baseURL         string
	defaultVHost    string
	defaultQueue    string
	defaultExchange string
	pageSize        int
	authHeaders     map[string]string
	forwarder       *ssh.LocalForwarder
}
