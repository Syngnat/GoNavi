package ssh

import (
	"context"
	"fmt"
	"net"
	"os"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/ssh"
)

// ViaSSHDialer registers a custom network for MySQL that proxies through SSH
type ViaSSHDialer struct {
	sshClient *ssh.Client
}

func (d *ViaSSHDialer) Dial(ctx context.Context, addr string) (net.Conn, error) {
	return dialContext(ctx, d.sshClient, "tcp", addr)
}

func dialContext(ctx context.Context, client *ssh.Client, network, addr string) (net.Conn, error) {
	type result struct {
		conn net.Conn
		err  error
	}

	ch := make(chan result, 1)
	go func() {
		c, err := client.Dial(network, addr)
		ch <- result{conn: c, err: err}
	}()

	select {
	case <-ctx.Done():
		go func() {
			r := <-ch
			if r.conn != nil {
				_ = r.conn.Close()
			}
		}()
		return nil, ctx.Err()
	case r := <-ch:
		return r.conn, r.err
	}
}

// connectSSH establishes an SSH connection and returns a Dialer
func connectSSH(config connection.SSHConfig) (*ssh.Client, error) {
	logger.Infof("开始建立 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)
	authMethods := []ssh.AuthMethod{}

	if config.KeyPath != "" {
		key, err := os.ReadFile(config.KeyPath)
		if err != nil {
			logger.Warnf("读取 SSH 私钥失败：路径=%s，原因：%v", config.KeyPath, err)
		} else {
			signer, err := ssh.ParsePrivateKey(key)
			if err != nil {
				logger.Warnf("解析 SSH 私钥失败：路径=%s，原因：%v", config.KeyPath, err)
			} else {
				authMethods = append(authMethods, ssh.PublicKeys(signer))
			}
		}
	}
	
	if config.Password != "" {
		authMethods = append(authMethods, ssh.Password(config.Password))
	}
	if len(authMethods) == 0 {
		logger.Warnf("SSH 未配置认证方式（密码或私钥）")
	}

	sshConfig := &ssh.ClientConfig{
		User:            config.User,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // Use strict checking in production!
		Timeout:         5 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)
	client, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		logger.Error(err, "SSH 连接建立失败：地址=%s 用户=%s", addr, config.User)
		return nil, err
	}
	logger.Infof("SSH 连接建立成功：地址=%s 用户=%s", addr, config.User)
	return client, nil
}

// RegisterSSHNetwork registers a unique network name for a specific SSH tunnel
// Returns the network name to use in DSN
func RegisterSSHNetwork(sshConfig connection.SSHConfig) (string, error) {
	client, err := connectSSH(sshConfig)
	if err != nil {
		return "", err
	}

	// Generate unique network name
	netName := fmt.Sprintf("ssh_%s_%d", sshConfig.Host, time.Now().UnixNano())
	logger.Infof("注册 SSH 网络：%s（地址=%s:%d 用户=%s）", netName, sshConfig.Host, sshConfig.Port, sshConfig.User)
	
	mysql.RegisterDialContext(netName, func(ctx context.Context, addr string) (net.Conn, error) {
		return dialContext(ctx, client, "tcp", addr)
	})

	return netName, nil
}
