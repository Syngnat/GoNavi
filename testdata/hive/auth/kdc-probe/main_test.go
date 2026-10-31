package main

import (
	"testing"

	"github.com/jcmturner/gokrb5/v8/credentials"
	"github.com/jcmturner/gokrb5/v8/types"
)

func TestTGTOnly(t *testing.T) {
	entry := func(realm, name string) *credentials.Credential {
		item := &credentials.Credential{}
		item.Server.Realm = realm
		item.Server.PrincipalName = types.NewPrincipalName(1, name)
		return item
	}
	tgt := entry("GONAVI.TEST", "krbtgt/GONAVI.TEST")
	metadata := entry("X-CACHECONF:", "krb5_ccache_conf_data/fast_avail/krbtgt/GONAVI.TEST@GONAVI.TEST")
	service := entry("GONAVI.TEST", "hive/hive.gonavi.test")
	cases := []struct {
		name  string
		items []*credentials.Credential
		want  bool
	}{
		{name: "empty"},
		{name: "TGT only", items: []*credentials.Credential{tgt}, want: true},
		{name: "MIT metadata allowed", items: []*credentials.Credential{metadata, tgt}, want: true},
		{name: "metadata is not TGT", items: []*credentials.Credential{metadata}},
		{name: "cached service would bypass KDC", items: []*credentials.Credential{tgt, service}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := tgtOnly(&credentials.CCache{Credentials: test.items}); got != test.want {
				t.Fatalf("TGT-only=%v want=%v", got, test.want)
			}
		})
	}
}
