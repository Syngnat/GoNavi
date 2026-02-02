package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/ssh"
)

type SSHConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	KeyPath  string `json:"keyPath"`
}

// ViaSSHDialer registers a custom network for MySQL that proxies through SSH
type ViaSSHDialer struct {
	sshClient *ssh.Client
}

func (d *ViaSSHDialer) Dial(ctx context.Context, addr string) (net.Conn, error) {
	return d.sshClient.Dial("tcp", addr)
}

// connectSSH establishes an SSH connection and returns a Dialer
func connectSSH(config SSHConfig) (*ssh.Client, error) {
	authMethods := []ssh.AuthMethod{}

	if config.KeyPath != "" {
		key, err := os.ReadFile(config.KeyPath)
		if err == nil {
			signer, err := ssh.ParsePrivateKey(key)
			if err == nil {
				authMethods = append(authMethods, ssh.PublicKeys(signer))
			}
		}
	}
	
	if config.Password != "" {
		authMethods = append(authMethods, ssh.Password(config.Password))
	}

	sshConfig := &ssh.ClientConfig{
		User:            config.User,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // Use strict checking in production!
		Timeout:         5 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)
	return ssh.Dial("tcp", addr, sshConfig)
}

// RegisterSSHNetwork registers a unique network name for a specific SSH tunnel
// Returns the network name to use in DSN
func RegisterSSHNetwork(sshConfig SSHConfig) (string, error) {
	client, err := connectSSH(sshConfig)
	if err != nil {
		return "", err
	}

	// Generate unique network name
	netName := fmt.Sprintf("ssh_%s_%d", sshConfig.Host, time.Now().UnixNano())
	
	mysql.RegisterDialContext(netName, func(ctx context.Context, addr string) (net.Conn, error) {
		return client.Dial("tcp", addr)
	})

	return netName, nil
}
