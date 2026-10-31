//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"fmt"
	"strings"

	"github.com/jcmturner/gokrb5/v8/client"
	krbconfig "github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/types"
)

func hiveKerberosPrincipalRealm(conf *krbconfig.Config, principal, serverName string) error {
	service, realm, explicit := strings.Cut(principal, "@")
	if !explicit {
		return nil
	}
	if realm == "" || strings.Contains(realm, "@") {
		return fmt.Errorf("invalid Hive Kerberos service realm")
	}
	service = strings.ReplaceAll(service, "_HOST", strings.ToLower(serverName))
	_, host, ok := strings.Cut(service, "/")
	if !ok || host == "" || strings.Contains(host, "/") {
		return fmt.Errorf("Hive Kerberos service principal must be service/host@REALM")
	}
	// This config belongs to one client. An explicit SPN realm overrides local
	// domain_realm only for that host, instead of silently falling back to user realm.
	if conf.DomainRealm == nil {
		conf.DomainRealm = make(krbconfig.DomainRealm)
	}
	conf.DomainRealm[host] = realm
	return nil
}

func hiveKerberosServiceTicket(cfg hiveConfig, kerberos *client.Client, host string, httpMode bool) (messages.Ticket, types.EncryptionKey, error) {
	if host == "" {
		host = cfg.Host
	}
	ticket, key, err := kerberos.GetServiceTicket(hiveServicePrincipal(cfg, host, httpMode))
	if err != nil {
		return ticket, key, err
	}
	if _, realm, explicit := strings.Cut(cfg.principal, "@"); explicit && ticket.Realm != realm {
		return messages.Ticket{}, types.EncryptionKey{}, fmt.Errorf("Hive cached service ticket realm does not match the explicit principal; use a matching credential cache")
	}
	return ticket, key, nil
}
