//go:build wails3

package main

import (
	"testing"

	"GoNavi-Wails/shared/i18n"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestMacPreferencesMenuLabelsTopLevelItems(t *testing.T) {
	localizer, err := i18n.NewLocalizer(i18n.LanguageZhCN)
	if err != nil {
		t.Fatalf("NewLocalizer() error = %v", err)
	}
	preferences := newMacPreferencesMenu(localizer, nil)
	menu := application.NewMenu()
	preferences.appendTo(menu)

	labels := func() []string {
		var result []string
		for index := 0; ; index++ {
			item := menu.ItemAt(index)
			if item == nil {
				return result
			}
			result = append(result, item.Label())
		}
	}
	assertLabels := func(want ...string) {
		t.Helper()
		got := labels()
		if len(got) != len(want) {
			t.Fatalf("top-level menu labels = %v, want %v", got, want)
		}
		for index := range want {
			if got[index] != want[index] {
				t.Fatalf("top-level menu labels = %v, want %v", got, want)
			}
		}
	}

	assertLabels("设置", "主题", "驱动管理", "关于")

	if !preferences.setLanguage("en-US") {
		t.Fatal("setLanguage(en-US) = false, want relabel")
	}
	assertLabels("Settings", "Theme", "Driver Manager", "About")
}
