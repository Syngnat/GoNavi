package db

import (
	"strings"
	"testing"
	"GoNavi-Wails/shared/i18n"
)

func TestMQTTTimeoutMessagesUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cases := []struct {
		name string
		key  string
		want string
		raw  string
	}{
		{
			name: "connect timeout",
			key:  "db.backend.error.mqtt_connect_timeout",
			want: "MQTT connection timed out",
			raw:  "MQTT 连接超时",
		},
		{
			name: "subscribe timeout",
			key:  "db.backend.error.mqtt_subscribe_timeout",
			want: "MQTT subscription timed out",
			raw:  "MQTT 订阅超时",
		},
		{
			name: "publish timeout",
			key:  "db.backend.error.mqtt_publish_timeout",
			want: "MQTT publish timed out",
			raw:  "MQTT 发布超时",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := localizedDriverRuntimeText(tc.key, nil)
			if got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
			if strings.Contains(got, tc.raw) {
				t.Fatalf("expected no raw Chinese timeout text, got %q", got)
			}
		})
	}
}


func TestMQTTTimeoutCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.mqtt_connect_timeout",
		"db.backend.error.mqtt_subscribe_timeout",
		"db.backend.error.mqtt_publish_timeout",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing MQTT timeout key %q", language, key)
			}
		}
	}
}
