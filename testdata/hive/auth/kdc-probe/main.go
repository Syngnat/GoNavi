// Command kdc-probe obtains real service tickets through the temporary SSH tunnel.
// It does not connect to HiveServer2 or print any credential material.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jcmturner/gokrb5/v8/client"
	krbconfig "github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/credentials"
	"github.com/jcmturner/gokrb5/v8/keytab"
)

const realm = "GONAVI.TEST"

type result struct {
	Mode                   string   `json:"mode"`
	Passed                 bool     `json:"passed"`
	ServicePrincipals      []string `json:"servicePrincipals,omitempty"`
	UnknownServiceRejected bool     `json:"unknownServiceRejected"`
	ElapsedMS              int64    `json:"elapsedMs"`
	Error                  string   `json:"error,omitempty"`
}

func main() {
	directory := flag.String("dir", "", "private TEMP client fixture directory")
	flag.Parse()
	failed := false
	for _, mode := range []string{"keytab", "password", "ccache"} {
		item := run(*directory, mode)
		if err := json.NewEncoder(os.Stdout).Encode(item); err != nil {
			fmt.Fprintln(os.Stderr, "encode public ticket-test result failed")
			os.Exit(1)
		}
		failed = failed || !item.Passed
	}
	if failed {
		os.Exit(1)
	}
}

func run(directory, mode string) (output result) {
	output.Mode = mode
	started := time.Now()
	defer func() { output.ElapsedMS = time.Since(started).Milliseconds() }()
	conf, err := krbconfig.Load(filepath.Join(directory, "krb5.conf"))
	if err != nil {
		output.Error = "load private client Kerberos configuration failed"
		return output
	}
	kerberos, err := loadClient(directory, mode, conf)
	if err != nil {
		output.Error = err.Error()
		return output
	}
	defer kerberos.Destroy()
	for _, service := range []string{"hive/hive.gonavi.test", "HTTP/hive.gonavi.test"} {
		ticket, _, err := kerberos.GetServiceTicket(service)
		if err != nil {
			output.Error = fmt.Sprintf("obtain %s service ticket: %v", service, err)
			return output
		}
		if ticket.Realm != realm || ticket.SName.PrincipalNameString() != service {
			output.Error = "KDC returned an unexpected service identity"
			return output
		}
		output.ServicePrincipals = append(output.ServicePrincipals, service+"@"+ticket.Realm)
	}
	_, _, err = kerberos.GetServiceTicket("missing/hive.gonavi.test")
	output.UnknownServiceRejected = err != nil && strings.Contains(err.Error(), "KDC_ERR_S_PRINCIPAL_UNKNOWN")
	if !output.UnknownServiceRejected {
		output.Error = "KDC did not reject the unknown service principal as expected"
		return output
	}
	output.Passed = true
	return output
}

func loadClient(directory, mode string, conf *krbconfig.Config) (*client.Client, error) {
	var kerberos *client.Client
	switch mode {
	case "keytab":
		kt, err := keytab.Load(filepath.Join(directory, "gonavi.keytab"))
		if err != nil {
			return nil, errors.New("load private client keytab failed")
		}
		kerberos = client.NewWithKeytab("gonavi", realm, kt, conf, client.DisablePAFXFAST(true))
	case "password":
		data, err := os.ReadFile(filepath.Join(directory, "gonavi.password"))
		if err != nil {
			return nil, errors.New("read private password file failed")
		}
		kerberos = client.NewWithPassword("gonavi", realm, strings.TrimSpace(string(data)), conf, client.DisablePAFXFAST(true))
	case "ccache":
		cache, err := credentials.LoadCCache(filepath.Join(directory, "gonavi.ccache"))
		if err != nil {
			return nil, errors.New("load private credential cache failed")
		}
		if !tgtOnly(cache) {
			return nil, errors.New("ccache must contain only TGT entries, so service tickets require the real KDC")
		}
		return client.NewFromCCache(cache, conf, client.DisablePAFXFAST(true))
	default:
		return nil, errors.New("unsupported credential mode")
	}
	if err := kerberos.Login(); err != nil {
		kerberos.Destroy()
		return nil, fmt.Errorf("real KDC login failed: %w", err)
	}
	return kerberos, nil
}

func tgtOnly(cache *credentials.CCache) bool {
	if len(cache.Credentials) == 0 {
		return false
	}
	foundTGT := false
	for _, item := range cache.Credentials {
		name := item.Server.PrincipalName.PrincipalNameString()
		if strings.HasPrefix(name, "krbtgt/") {
			foundTGT = true
			continue
		}
		// MIT kinit adds cache configuration metadata; it is not a service ticket.
		if item.Server.Realm == "X-CACHECONF:" && strings.HasPrefix(name, "krb5_ccache_conf_data/") {
			continue
		}
		return false
	}
	return foundTGT
}
