//go:build gonavi_full_drivers || gonavi_hive_driver

// Command probe verifies the public Hive driver against the isolated auth lab.
package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type probeConfig struct {
	Name         string                      `json:"name"`
	Connection   connection.ConnectionConfig `json:"connection"`
	PasswordFile string                      `json:"passwordFile"`
	ExpectedUser string                      `json:"expectedUser"`
	Expect       string                      `json:"expect"`
}

type probeResult struct {
	Name          string `json:"name"`
	Passed        bool   `json:"passed"`
	Expectation   string `json:"expectation"`
	Connect       bool   `json:"connect"`
	Ping          bool   `json:"ping"`
	SelectOne     bool   `json:"selectOne"`
	Authenticated string `json:"authenticatedUser,omitempty"`
	ElapsedMS     int64  `json:"elapsedMs"`
	Error         string `json:"error,omitempty"`
}

func main() {
	path := flag.String("config", "", "private JSON config path; never put credentials in flags")
	flag.Parse()
	result, err := execute(*path)
	if encodeErr := json.NewEncoder(os.Stdout).Encode(result); encodeErr != nil {
		fmt.Fprintln(os.Stderr, "encode probe result failed")
		os.Exit(1)
	}
	if err != nil || !result.Passed {
		os.Exit(1)
	}
}

func execute(path string) (result probeResult, resultErr error) {
	started := time.Now()
	defer func() { result.ElapsedMS = time.Since(started).Milliseconds() }()
	config, err := loadConfig(path)
	if err != nil {
		result.Error = err.Error()
		return result, err
	}
	result.Name, result.Expectation = config.Name, config.Expect
	driver := &db.HiveDB{}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	err = driver.ConnectContext(ctx, config.Connection)
	if err != nil {
		result.Passed = expectedRejection(config.Expect, err)
		result.Error = redact(err.Error(), config.Connection.Password)
		if result.Passed {
			return result, nil
		}
		return result, err
	}
	result.Connect = true
	defer func() {
		if err := driver.Close(); err != nil {
			result.Passed = false
			result.Error = redact(err.Error(), config.Connection.Password)
			resultErr = errors.Join(resultErr, err)
		}
	}()
	if config.Expect != "success" {
		result.Error = "server unexpectedly accepted the negative test"
		return result, errors.New(result.Error)
	}
	if err = driver.PingContext(ctx); err != nil {
		result.Error = redact(err.Error(), config.Connection.Password)
		return result, err
	}
	result.Ping = true
	rows, fields, err := driver.QueryContext(ctx, "SELECT 1 AS gonavi_auth_probe")
	if err != nil || len(rows) != 1 || len(fields) != 1 || fmt.Sprint(rows[0][fields[0]]) != "1" {
		result.Error = "SELECT 1 result mismatch"
		if err != nil {
			result.Error = redact(err.Error(), config.Connection.Password)
		}
		return result, errors.New(result.Error)
	}
	result.SelectOne = true
	rows, fields, err = driver.QueryContext(ctx, "SELECT logged_in_user() AS gonavi_user")
	if err != nil || len(rows) != 1 || len(fields) != 1 {
		result.Error = "logged-in user query failed"
		if err != nil {
			result.Error = redact(err.Error(), config.Connection.Password)
		}
		return result, errors.New(result.Error)
	}
	result.Authenticated = fmt.Sprint(rows[0][fields[0]])
	if config.ExpectedUser != "" && result.Authenticated != config.ExpectedUser {
		result.Error = "server authenticated an unexpected user"
		return result, errors.New(result.Error)
	}
	result.Passed = true
	return result, nil
}

func loadConfig(path string) (probeConfig, error) {
	var config probeConfig
	file, err := os.Open(path)
	if err != nil {
		return config, fmt.Errorf("open private probe configuration: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, errors.New("invalid private probe configuration")
	}
	if config.Connection.Password != "" {
		return config, errors.New("use passwordFile instead of inline password")
	}
	if config.PasswordFile != "" {
		password, err := os.ReadFile(config.PasswordFile)
		if err != nil {
			return config, fmt.Errorf("read private password file: %w", err)
		}
		config.Connection.Password = strings.TrimSpace(string(password))
	}
	if config.Expect == "" {
		config.Expect = "success"
	}
	if config.Connection.Type == "" {
		config.Connection.Type = "hive"
	}
	return config, nil
}

func expectedRejection(expect string, err error) bool {
	var unknownCA x509.UnknownAuthorityError
	var wrongHost x509.HostnameError
	switch expect {
	case "tls-untrusted":
		return errors.As(err, &unknownCA)
	case "tls-hostname":
		return errors.As(err, &wrongHost)
	case "kdc-preauth-rejected":
		return strings.Contains(err.Error(), "KDC_ERR_PREAUTH_FAILED")
	case "service-principal-rejected":
		return strings.Contains(err.Error(), "KDC_ERR_S_PRINCIPAL_UNKNOWN")
	case "hs2-auth-rejected":
		return strings.Contains(err.Error(), "SASL authentication rejected") || strings.Contains(err.Error(), "HTTP server returned status 401")
	default:
		return false
	}
}

func redact(message, password string) string {
	if password != "" {
		return strings.ReplaceAll(message, password, "[REDACTED]")
	}
	return message
}
