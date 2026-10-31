package marketfilter

import "testing"

func TestNormalizeAndMatch(t *testing.T) {
	value, err := Normalize(Filters{Categories: []string{"ops", "skill", "ops"}, Platforms: []string{"windows/amd64", "linux/arm64"}, Official: "official", Author: " GoNavi "})
	if err != nil {
		t.Fatal(err)
	}
	if len(value.Categories) != 2 || value.Categories[0] != "ops" || value.Author != "GoNavi" {
		t.Fatalf("normalized=%+v", value)
	}
	for _, test := range []struct {
		name, category, author string
		official               bool
		platforms              []string
		want                   bool
	}{
		{"all fields", "skill", "GoNavi Project", true, []string{"linux/arm64"}, true},
		{"list OR", "ops", "GONAVI", true, []string{"windows/amd64"}, true},
		{"wrong author", "ops", "other", true, []string{"windows/amd64"}, false},
		{"wrong identity", "ops", "GoNavi", false, []string{"windows/amd64"}, false},
		{"wrong category", "panel", "GoNavi", true, []string{"windows/amd64"}, false},
		{"wrong platform", "ops", "GoNavi", true, []string{"darwin/arm64"}, false},
		{"universal", "ops", "GoNavi", true, []string{"any"}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := Matches(value, test.category, test.author, "publisher", test.official, test.platforms); got != test.want {
				t.Fatalf("match=%v want=%v", got, test.want)
			}
		})
	}
}
func TestInvalidFilters(t *testing.T) {
	for _, value := range []Filters{{Categories: []string{"unknown"}}, {Platforms: []string{"all", "linux/amd64"}}, {Platforms: []string{"../etc"}}, {Official: "trusted"}, {Author: "bad\x00value"}} {
		if value.Author != "" {
			value.Author = string([]byte{'b', 0})
		}
		if _, err := Normalize(value); err == nil {
			t.Fatalf("accepted %+v", value)
		}
	}
}
