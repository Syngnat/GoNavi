package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestDriverStatusItemJSONIncludesStableReasonCode(t *testing.T) {
	item := driverStatusItem{
		Type:       "clickhouse",
		Name:       "ClickHouse",
		ReasonCode: driverStatusReasonSlimBuildMissingDriver,
	}

	payload, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal driver status item: %v", err)
	}

	if !strings.Contains(string(payload), `"reasonCode":"slim_build_missing_driver"`) {
		t.Fatalf("expected stable reasonCode in payload, got %s", string(payload))
	}
}

func TestDriverNetworkProbeItemJSONIncludesStableProbeCode(t *testing.T) {
	item := driverNetworkProbeItem{
		ProbeCode: driverNetworkProbeCodeDownloadMirror,
		Name:      driverNetworkProbeNameDownloadMirror,
		URL:       driverReleaseMirrorLatestIndexURL,
	}

	payload, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal driver network probe item: %v", err)
	}

	if !strings.Contains(string(payload), `"probeCode":"download_mirror"`) {
		t.Fatalf("expected stable probeCode in payload, got %s", string(payload))
	}
}

func TestDriverDownloadMirrorProbeUsesProviderNeutralIdentity(t *testing.T) {
	item := driverNetworkProbeItem{
		ProbeCode: driverNetworkProbeCodeDownloadMirror,
		Name:      driverNetworkProbeNameDownloadMirror,
		URL:       "https://download.syngnat.top/health.txt",
	}

	payload, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal download mirror network probe item: %v", err)
	}

	serialized := string(payload)
	if !strings.Contains(serialized, `"probeCode":"download_mirror"`) {
		t.Fatalf("expected provider-neutral mirror probeCode, got %s", serialized)
	}
	if !strings.Contains(serialized, `"name":"GoNavi Mirror"`) {
		t.Fatalf("expected provider-neutral mirror name, got %s", serialized)
	}
}

func TestCheckDriverNetworkStatusStopsAfterHealthyMirror(t *testing.T) {
	var probeCodes []string
	result := (&App{}).checkDriverNetworkStatusWithProbe(func(_ *http.Client, item driverNetworkProbeItem) driverNetworkProbeItem {
		probeCodes = append(probeCodes, item.ProbeCode)
		if item.ProbeCode != driverNetworkProbeCodeDownloadMirror {
			t.Fatalf("healthy mirror must prevent fallback probe %q", item.ProbeCode)
		}
		item.Reachable = true
		item.HTTPStatus = http.StatusOK
		return item
	})

	if len(probeCodes) != 1 || probeCodes[0] != driverNetworkProbeCodeDownloadMirror {
		t.Fatalf("probe sequence = %v, want mirror only", probeCodes)
	}
	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected network result data: %#v", result.Data)
	}
	if data["mirrorReachable"] != true || data["fallbackChecked"] != false || data["usingFallback"] != false {
		t.Fatalf("unexpected healthy mirror state: %#v", data)
	}
}

func TestCheckDriverNetworkStatusProbesFallbacksOnlyAfterMirrorFailure(t *testing.T) {
	var probeCodes []string
	result := (&App{}).checkDriverNetworkStatusWithProbe(func(_ *http.Client, item driverNetworkProbeItem) driverNetworkProbeItem {
		probeCodes = append(probeCodes, item.ProbeCode)
		item.Reachable = true
		item.HTTPStatus = http.StatusOK
		if item.ProbeCode == driverNetworkProbeCodeDownloadMirror {
			item.HTTPStatus = http.StatusNotFound
		}
		return item
	})

	wantCodes := []string{
		driverNetworkProbeCodeDownloadMirror,
		driverNetworkProbeCodeGitHubAPI,
		driverNetworkProbeCodeGitHubRelease,
		driverNetworkProbeCodeGitHubReleaseAsset,
		driverNetworkProbeCodeGoModuleProxy,
	}
	if len(probeCodes) != len(wantCodes) {
		t.Fatalf("probe sequence = %v, want %v", probeCodes, wantCodes)
	}
	for index, wantCode := range wantCodes {
		if probeCodes[index] != wantCode {
			t.Fatalf("probe sequence = %v, want %v", probeCodes, wantCodes)
		}
	}
	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected network result data: %#v", result.Data)
	}
	if data["reachable"] != true || data["allReachable"] != false || data["mirrorReachable"] != false || data["fallbackChecked"] != true || data["fallbackReachable"] != true || data["usingFallback"] != true {
		t.Fatalf("unexpected fallback state: %#v", data)
	}
	if data["recommendedProxy"] != false {
		t.Fatalf("working fallback must not recommend a proxy: %#v", data)
	}
}

func TestCheckDriverNetworkStatusReportsAllDownloadRoutesUnavailable(t *testing.T) {
	result := (&App{}).checkDriverNetworkStatusWithProbe(func(_ *http.Client, item driverNetworkProbeItem) driverNetworkProbeItem {
		item.Reachable = false
		item.Error = "blocked"
		return item
	})

	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected network result data: %#v", result.Data)
	}
	if data["reachable"] != false || data["fallbackReachable"] != false || data["usingFallback"] != false || data["downloadChainReachable"] != false {
		t.Fatalf("unexpected unavailable state: %#v", data)
	}
	if data["recommendedProxy"] != true {
		t.Fatalf("unavailable routes must recommend a proxy: %#v", data)
	}
}

func TestBuildDriverNetworkProbeItemsUsesCurrentMirrorIndex(t *testing.T) {
	originalVersion := AppVersion
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	tests := []struct {
		name    string
		version string
		wantURL string
	}{
		{name: "stable", version: "1.2.3", wantURL: driverReleaseMirrorLatestIndexURL},
		{name: "dev", version: "dev-a1b2c3d", wantURL: driverReleaseMirrorDevLatestIndexURL},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			AppVersion = test.version
			items := buildDriverNetworkProbeItems()
			if len(items) != 1 {
				t.Fatalf("network probes = %v, want one mirror probe", items)
			}
			item := items[0]
			if item.ProbeCode != driverNetworkProbeCodeDownloadMirror || item.Name != driverNetworkProbeNameDownloadMirror {
				t.Fatalf("unexpected mirror probe identity: %#v", item)
			}
			if item.URL != test.wantURL {
				t.Fatalf("mirror probe URL = %q, want %q", item.URL, test.wantURL)
			}
			if strings.Contains(strings.ToLower(item.URL), "github") {
				t.Fatalf("mirror probe must not contact GitHub: %q", item.URL)
			}
		})
	}
}
