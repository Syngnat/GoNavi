package db

import (
	"slices"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestApplyMySQLURIHostPrecedence(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		config        connection.ConnectionConfig
		wantHost      string
		wantPort      int
		wantHosts     []string
		wantUser      string
		wantPassword  string
		wantDatabase  string
		wantAddresses []string
	}{
		{
			// 存量连接把地址改成新主机但密文库里仍留着旧 URI 时，不能再拨旧地址。
			name: "explicit host wins over URI host",
			config: connection.ConnectionConfig{
				Type: "mysql",
				Host: "47.103.101.111",
				Port: 13306,
				User: "root",
				URI:  "mysql://root@47.98.49.192:13306/?timeout=30",
			},
			wantHost:      "47.103.101.111",
			wantPort:      13306,
			wantUser:      "root",
			wantAddresses: []string{"47.103.101.111:13306"},
		},
		{
			name: "URI fills empty host",
			config: connection.ConnectionConfig{
				Type: "mysql",
				URI:  "mysql://root@10.0.0.9:3307/app",
			},
			wantHost:      "10.0.0.9",
			wantPort:      3307,
			wantHosts:     []string{"10.0.0.9:3307"},
			wantUser:      "root",
			wantDatabase:  "app",
			wantAddresses: []string{"10.0.0.9:3307"},
		},
		{
			name: "explicit hosts win over URI host",
			config: connection.ConnectionConfig{
				Type:  "mysql",
				Hosts: []string{"10.0.0.1:3306"},
				URI:   "mysql://root@10.0.0.9:3307/app",
			},
			wantHosts:     []string{"10.0.0.1:3306"},
			wantUser:      "root",
			wantDatabase:  "app",
			wantAddresses: []string{"10.0.0.1:3306"},
		},
		{
			name: "URI still fills empty user password and database",
			config: connection.ConnectionConfig{
				Type: "mysql",
				Host: "10.0.0.1",
				Port: 3306,
				URI:  "mysql://uri-user:uri-pass@10.0.0.9:3307/app",
			},
			wantHost:      "10.0.0.1",
			wantPort:      3306,
			wantUser:      "uri-user",
			wantPassword:  "uri-pass",
			wantDatabase:  "app",
			wantAddresses: []string{"10.0.0.1:3306"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			got := applyMySQLURI(test.config)
			if got.Host != test.wantHost || got.Port != test.wantPort {
				t.Fatalf("endpoint = %s:%d, want %s:%d", got.Host, got.Port, test.wantHost, test.wantPort)
			}
			if !slices.Equal(got.Hosts, test.wantHosts) {
				t.Fatalf("hosts = %v, want %v", got.Hosts, test.wantHosts)
			}
			if got.User != test.wantUser || got.Password != test.wantPassword || got.Database != test.wantDatabase {
				t.Fatalf("credentials = %q/%q/%q, want %q/%q/%q",
					got.User, got.Password, got.Database,
					test.wantUser, test.wantPassword, test.wantDatabase)
			}
			if addresses := collectMySQLAddresses(got); !slices.Equal(addresses, test.wantAddresses) {
				t.Fatalf("dial addresses = %v, want %v", addresses, test.wantAddresses)
			}
		})
	}
}
