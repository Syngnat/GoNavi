package plugin

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestShippedContributionNamesRoundTrip(t *testing.T) {
	manifest := Manifest{
		SchemaVersion: 1, APIVersion: 1, ID: "example.bundle", Name: "Bundle", Version: "1.0.0",
		Permissions: []string{"data.sources", "ai.skills", "ai.providers", "data.export"},
		Contributes: &Contributions{
			DataSources: []DataSource{{ID: "db", Name: "DB", Dialect: "sqlite", Command: "db", ReadOnly: true}},
			Skills:      []Skill{{ID: "guide", Name: "Guide", Description: "Read", Entry: "SKILL.md", Resources: []string{"NOTES.md"}}},
			AIProviders: []AIProvider{{ID: "chat", Name: "Chat", Command: "chat", Models: []AIModel{{ID: "m", Name: "M", ContextWindow: 8, MaxOutputTokens: 2}}, SupportsTools: true, SupportsImages: false}},
			Exporters:   []Exporter{{ID: "ndjson", Name: "NDJSON", Command: "export", Extension: "ndjson", ContentType: "application/x-ndjson"}},
			Pages:       []Page{{ID: "overview", Title: "Overview", Body: &UINode{Type: "text", Text: "hello"}}},
			Navigation:  []Navigation{{ID: "overview-tools", Title: "Overview", Page: "overview", Location: PageLocationTools}},
		},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"\"dataSources\"", "\"skills\"", "\"resources\"", "\"aiProviders\"", "\"supportsImages\":false", "\"exporters\"", "\"pages\"", "\"navigation\"", "\"location\":\"tools\""} {
		if !strings.Contains(string(raw), name) {
			t.Fatalf("missing %s in %s", name, raw)
		}
	}
	var decoded Manifest
	if err = json.Unmarshal(raw, &decoded); err != nil || decoded.Contributes == nil || len(decoded.Contributes.Exporters) != 1 || !decoded.Contributes.DataSources[0].ReadOnly || len(decoded.Contributes.Pages) != 1 || len(decoded.Contributes.Navigation) != 1 {
		t.Fatal(err)
	}
}
