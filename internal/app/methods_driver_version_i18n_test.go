package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

func TestMethodsDriverUnsupportedVersionErrorsUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	functionSource := methodsDriverFunctionSource(t, source, "func (a *App) localizeDriverSelectionError")
	for _, key := range []string{
		"driver_manager.backend.error.mongo_version_unsupported",
		"driver_manager.backend.error.driver_version_unsupported",
	} {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("localizeDriverSelectionError does not reference unsupported-version i18n key %q", key)
		}
	}
}

func TestMethodsDriverUnsupportedVersionErrorTypesUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func (e *driverBuildUnavailableError) Error() string": {
			rawMessages: []string{
				`fmt.Sprintf("%s 当前发行包为精简构建，未内置该驱动；如需使用请安装 Full 版", strings.TrimSpace(e.Name))`,
			},
			keys: []string{
				"driver_manager.backend.status.slim_build_required",
			},
		},
		"func (e *driverVersionValidationError) Error() string": {
			rawMessages: []string{
				`fmt.Sprintf("MongoDB 版本 %s 当前不受支持；仅支持 1.17.x 和 2.x", versionText)`,
				`fmt.Sprintf("%s 版本 %s 当前不受支持", driverType, versionText)`,
			},
			keys: []string{
				"driver_manager.backend.error.mongo_version_unsupported",
				"driver_manager.backend.error.driver_version_unsupported",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw unsupported-version error text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference unsupported-version error i18n key %q", signature, key)
			}
		}
	}
}

func TestMethodsDriverUnsupportedVersionErrorCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.error.mongo_version_unsupported",
		"driver_manager.backend.error.driver_version_unsupported",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing unsupported-version key %q", language, key)
			}
		}
	}
}

func TestDriverSelectionErrorTypesUseCurrentLanguageDirectly(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	cases := []struct {
		name  string
		err   error
		want  string
		avoid string
	}{
		{
			name:  "slim build required",
			err:   &driverBuildUnavailableError{Name: "ClickHouse"},
			want:  "ClickHouse is not included in the current slim build. Install the Full edition to use this driver.",
			avoid: "当前发行包为精简构建",
		},
		{
			name: "mongodb version unsupported",
			err: &driverVersionValidationError{
				DriverType: "mongodb",
				Version:    "1.16.9",
			},
			want:  "MongoDB version 1.16.9 is not supported; only 1.17.x and 2.x are supported",
			avoid: "当前不受支持；仅支持 1.17.x 和 2.x",
		},
		{
			name: "generic driver version unsupported",
			err: &driverVersionValidationError{
				DriverType: "clickhouse",
				Version:    " 24.3.1 ",
			},
			want:  "ClickHouse version 24.3.1 is not supported",
			avoid: "当前不受支持",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.err.Error()
			if got != tc.want {
				t.Fatalf("expected direct English driver error %q, got %q", tc.want, got)
			}
			if strings.Contains(got, tc.avoid) {
				t.Fatalf("expected no Chinese direct driver error in en-US mode, got %q", got)
			}
		})
	}
}

func TestLocalizeDriverSelectionErrorUsesCurrentLanguageForUnsupportedVersions(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	cases := []struct {
		name       string
		definition driverDefinition
		err        error
		want       string
		avoid      string
	}{
		{
			name:       "mongodb compatibility pin",
			definition: driverDefinition{Type: "mongodb", Name: "MongoDB"},
			err: &driverVersionValidationError{
				DriverType: "mongodb",
				Version:    "1.16.9",
			},
			want:  "MongoDB version 1.16.9 is not supported; only 1.17.x and 2.x are supported",
			avoid: "当前不受支持；仅支持 1.17.x 和 2.x",
		},
		{
			name:       "generic optional driver version",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			err: &driverVersionValidationError{
				DriverType: "clickhouse",
				Version:    " 24.3.1 ",
			},
			want:  "ClickHouse version 24.3.1 is not supported",
			avoid: "当前不受支持",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := app.localizeDriverSelectionError(tc.definition, tc.err)
			if err == nil {
				t.Fatal("expected unsupported version error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected English unsupported-version message %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.avoid) {
				t.Fatalf("expected no Chinese unsupported-version message in en-US mode, got %q", err.Error())
			}
		})
	}
}

func TestMethodsDriverRuntimeReasonCompatibilityUsesLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func parseDriverAgentArchIncompatibleDetail": {
			rawMessages: []string{
				`"可执行文件架构不兼容（文件="`,
				`"，当前进程="`,
			},
		},
		"func parseDriverAgentUnavailableDetail": {
			rawMessages: []string{
				`" 驱动代理不可用："`,
				`"；请在驱动管理中重新安装启用"`,
			},
			keys: []string{
				"driver_manager.backend.status.agent_unavailable_reinstall",
			},
		},
		"func (a *App) localizeDriverRuntimeReason": {
			rawMessages: []string{
				`"未识别的数据源类型"`,
				`fmt.Sprintf("%s 当前发行包为精简构建，未内置该驱动；如需使用请安装 Full 版", name)`,
				`fmt.Sprintf("%s 驱动代理路径解析失败，请在驱动管理中重新安装启用", name)`,
				`fmt.Sprintf("%s 驱动代理路径为空；请在驱动管理中重新安装启用", name)`,
				`fmt.Sprintf("%s 驱动代理缺失，请在驱动管理中重新安装启用", name)`,
				`fmt.Sprintf("%s 纯 Go 驱动未启用，请先在驱动管理中点击“安装启用”", name)`,
			},
			keys: []string{
				"driver_manager.backend.status.unrecognized_driver_type",
				"driver_manager.backend.status.slim_build_required",
				"driver_manager.backend.status.agent_path_failed",
				"driver_manager.backend.status.agent_missing",
				"driver_manager.backend.status.optional_disabled",
				"driver_manager.backend.status.agent_unavailable_reinstall",
				"driver_manager.backend.status.agent_arch_incompatible_detail",
			},
		},
		"func resolveDriverDisplayName": {
			rawMessages: []string{
				`return "未知"`,
			},
			keys: []string{
				"driver_manager.backend.driver_fallback_name",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw runtime-reason text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference runtime-reason i18n key %q", signature, key)
			}
		}
	}
}

func TestLocalizeDriverRuntimeReasonUsesCurrentLanguageForLegacyZhCNReasons(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	zhLocalizer, err := i18n.NewLocalizer(i18n.LanguageZhCN)
	if err != nil {
		t.Fatalf("NewLocalizer(zh-CN): %v", err)
	}

	buildLegacyAgentUnavailableReason := func(name string, detail string) string {
		current := zhLocalizer.T("driver_manager.backend.status.agent_unavailable_reinstall", map[string]any{
			"name":   name,
			"detail": detail,
		})
		return strings.Replace(current, detail+"。", detail+"；", 1)
	}

	cases := []struct {
		name       string
		definition driverDefinition
		reason     string
		want       string
		avoid      string
	}{
		{
			name:       "unrecognized driver type",
			definition: driverDefinition{},
			reason:     zhLocalizer.T("driver_manager.backend.status.unrecognized_driver_type", nil),
			want:       "Unrecognized data source type",
			avoid:      "未识别的数据源类型",
		},
		{
			name:       "slim build required",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.slim_build_required", map[string]any{
				"name": "ClickHouse",
			}),
			want:  "ClickHouse is not included in the current slim build. Install the Full edition to use this driver.",
			avoid: "当前发行包为精简构建",
		},
		{
			name:       "agent path failed",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.agent_path_failed", map[string]any{
				"name": "ClickHouse",
			}),
			want:  "ClickHouse driver agent path could not be resolved; reinstall and enable it in Driver Manager.",
			avoid: "驱动代理路径解析失败",
		},
		{
			name:       "agent missing",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.agent_missing", map[string]any{
				"name": "ClickHouse",
			}),
			want:  "ClickHouse driver agent is missing; reinstall and enable it in Driver Manager.",
			avoid: "驱动代理缺失",
		},
		{
			name:       "optional driver disabled",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.optional_disabled", map[string]any{
				"name": "ClickHouse",
			}),
			want:  "ClickHouse Go driver is not enabled; install and enable it in Driver Manager.",
			avoid: "纯 Go 驱动未启用",
		},
		{
			name:       "agent arch incompatible current zh-CN template",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: zhLocalizer.T("driver_manager.backend.status.agent_arch_incompatible_detail", map[string]any{
				"name":    "ClickHouse",
				"file":    "arm64",
				"process": "amd64",
			}),
			want:  "ClickHouse driver agent architecture is incompatible: file=arm64, current process=amd64; reinstall and enable it in Driver Manager.",
			avoid: "驱动代理架构不兼容",
		},
		{
			name:       "legacy unavailable wrapper with english arch detail",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason: buildLegacyAgentUnavailableReason(
				"ClickHouse",
				"driver agent architecture is incompatible (file=arm64, current process=amd64)",
			),
			want:  "ClickHouse driver agent architecture is incompatible: file=arm64, current process=amd64; reinstall and enable it in Driver Manager.",
			avoid: "驱动代理不可用",
		},
		{
			name:       "legacy unavailable wrapper keeps raw detail",
			definition: driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			reason:     buildLegacyAgentUnavailableReason("ClickHouse", "permission denied"),
			want:       "ClickHouse driver agent is unavailable: permission denied; reinstall and enable it in Driver Manager.",
			avoid:      "驱动代理不可用",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := app.localizeDriverRuntimeReason(tc.definition, tc.reason)
			if got != tc.want {
				t.Fatalf("expected localized runtime reason %q, got %q", tc.want, got)
			}
			if strings.Contains(got, tc.avoid) {
				t.Fatalf("expected no Chinese runtime reason fragment %q in %q", tc.avoid, got)
			}
		})
	}
}

func TestResolveDriverDisplayNameUsesCurrentLanguageFallbackName(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	got := resolveDriverDisplayName(driverDefinition{})
	if got != "driver" {
		t.Fatalf("expected English fallback driver display name %q, got %q", "driver", got)
	}
	if strings.Contains(got, "未知") {
		t.Fatalf("expected no Chinese fallback driver display name, got %q", got)
	}
}

func TestMethodsDriverUpdateStatusUsesLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	checks := map[string]struct {
		rawMessages []string
		keys        []string
	}{
		"func optionalDriverAgentRevisionStatus": {
			rawMessages: []string{
				`fmt.Sprintf("当前 GoNavi 版本要求更新后的 %s driver-agent（revision: %s）", displayName, expected)`,
				`impact := "driver-agent 是独立二进制，不会随主程序自动更新；如果不重装，会继续使用旧 agent 逻辑，驱动侧已修复或优化的行为不会生效，可能继续出现旧版本问题。强烈建议重装对应驱动代理"`,
				`fmt.Sprintf("原因：%s。影响：%s", updateReason, impact)`,
				`fmt.Sprintf("原因：%s。影响：%s（已安装标记：%s，当前需要：%s）", updateReason, impact, actual, expected)`,
			},
			keys: []string{
				"driver_manager.backend.status.agent_revision_update_detail",
				"driver_manager.backend.status.agent_revision_update_detail_with_actual",
			},
		},
		"func optionalDriverPackageUpdateStatus": {
			rawMessages: []string{
				`fmt.Sprintf("原因：当前推荐 MongoDB 兼容驱动版本为 %s，已安装版本为 %s。影响：MongoDB 2.x driver-agent 使用官方 v2 驱动，要求服务端 MongoDB 4.2+；连接 MongoDB 4.0 会出现 wire version 7 不兼容。强烈建议重装对应驱动代理", pinned, installed)`,
			},
			keys: []string{
				"driver_manager.backend.status.mongodb_compatibility_update_detail",
				"driver_manager.backend.status.optional_component_update_detail",
			},
		},
	}

	for signature, check := range checks {
		functionSource := methodsDriverFunctionSource(t, source, signature)
		for _, rawMessage := range check.rawMessages {
			if strings.Contains(functionSource, rawMessage) {
				t.Fatalf("%s still contains raw update status text %q", signature, rawMessage)
			}
		}
		for _, key := range check.keys {
			if !strings.Contains(functionSource, key) {
				t.Fatalf("%s does not reference update status i18n key %q", signature, key)
			}
		}
	}
}

func TestMethodsDriverUpdateStatusCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"driver_manager.backend.status.agent_revision_update_detail",
		"driver_manager.backend.status.agent_revision_update_detail_with_actual",
		"driver_manager.backend.status.mongodb_compatibility_update_detail",
		"driver_manager.backend.status.optional_component_update_detail",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing update status key %q", language, key)
			}
		}
	}
}

func TestOptionalDriverAgentRevisionStatusUsesCurrentLanguageForUpdateReason(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	needsUpdate, reason, expected := optionalDriverAgentRevisionStatus("clickhouse", installedDriverPackage{}, true)
	if !needsUpdate {
		t.Fatal("expected ClickHouse revision mismatch to require update")
	}
	if expected == "" {
		t.Fatal("expected ClickHouse to define an expected revision")
	}
	if !strings.Contains(reason, "Reason:") || !strings.Contains(reason, "Impact:") {
		t.Fatalf("expected English reason/impact wrapper, got %q", reason)
	}
	if !strings.Contains(reason, "ClickHouse driver-agent") || !strings.Contains(reason, expected) {
		t.Fatalf("expected English ClickHouse revision detail with expected revision, got %q", reason)
	}
	if strings.Contains(reason, "原因：") || strings.Contains(reason, "影响：") || strings.Contains(reason, "强烈建议重装") {
		t.Fatalf("expected no Chinese revision update reason in en-US mode, got %q", reason)
	}
}

func TestOptionalDriverPackageUpdateStatusUsesCurrentLanguageForMongoCompatibility(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}
	meta := installedDriverPackage{
		Version:       "2.5.0",
		AgentRevision: db.OptionalDriverAgentRevision("mongodb"),
	}

	needsUpdate, _, reason, _ := optionalDriverPackageUpdateStatus(definition, meta, true)
	if !needsUpdate {
		t.Fatal("expected MongoDB legacy compatibility prompt")
	}
	if !strings.Contains(reason, "Reason:") || !strings.Contains(reason, "Impact:") {
		t.Fatalf("expected English reason/impact wrapper, got %q", reason)
	}
	if !strings.Contains(reason, "recommended MongoDB compatibility driver version") || !strings.Contains(reason, "wire version 7") {
		t.Fatalf("expected English MongoDB compatibility detail, got %q", reason)
	}
	if strings.Contains(reason, "原因：") || strings.Contains(reason, "影响：") || strings.Contains(reason, "当前推荐 MongoDB 兼容驱动版本") {
		t.Fatalf("expected no Chinese MongoDB compatibility reason in en-US mode, got %q", reason)
	}
}
