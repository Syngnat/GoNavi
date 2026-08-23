package db

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	dataSourceCapabilityCustomProfile  = "custom"
	dataSourceCapabilityUnknownProfile = "unknown"
)

// DataSourceOperationCapability describes one user-visible operation. A
// runtimeProbe value means the registry can expose the entry point, while the
// connected driver still determines the final capability for that session.
type DataSourceOperationCapability struct {
	Supported    bool   `json:"supported"`
	RuntimeProbe bool   `json:"runtimeProbe,omitempty"`
	Reason       string `json:"reason,omitempty"`
	Alternative  string `json:"alternative,omitempty"`
	MessageKey   string `json:"messageKey,omitempty"`
}

// DataSourceUICapabilities keeps UI-specific affordances in the same registry
// as the backend operation boundaries. All fields are intentionally false by
// default so a newly declared profile must opt into an entry point explicitly.
type DataSourceUICapabilities struct {
	ExplainDiagnosis               bool `json:"explainDiagnosis"`
	SQLQueryExport                 bool `json:"sqlQueryExport"`
	CopyInsert                     bool `json:"copyInsert"`
	CopyTable                      bool `json:"copyTable"`
	CreateDatabase                 bool `json:"createDatabase"`
	CreateDatabaseCharset          bool `json:"createDatabaseCharset"`
	RenameDatabase                 bool `json:"renameDatabase"`
	DropDatabase                   bool `json:"dropDatabase"`
	MessagePublish                 bool `json:"messagePublish"`
	ForceReadOnlyQueryResult       bool `json:"forceReadOnlyQueryResult"`
	ForceReadOnlyStructureDesigner bool `json:"forceReadOnlyStructureDesigner"`
	PreferManualTotalCount         bool `json:"preferManualTotalCount"`
	SupportsApproximateTableCount  bool `json:"supportsApproximateTableCount"`
	SupportsApproximateTotalPages  bool `json:"supportsApproximateTotalPages"`
}

// DataSourceCapability is the shared, generated data-source contract returned
// by backend APIs and consumed directly by the frontend registry import.
type DataSourceCapability struct {
	Type                string                        `json:"type"`
	Query               DataSourceOperationCapability `json:"query"`
	Metadata            DataSourceOperationCapability `json:"metadata"`
	Transaction         DataSourceOperationCapability `json:"transaction"`
	Pagination          DataSourceOperationCapability `json:"pagination"`
	Cancel              DataSourceOperationCapability `json:"cancel"`
	Schema              DataSourceOperationCapability `json:"schema"`
	Sampling            DataSourceOperationCapability `json:"sampling"`
	Streaming           DataSourceOperationCapability `json:"streaming"`
	DangerousOperations DataSourceOperationCapability `json:"dangerousOperations"`
	UI                  DataSourceUICapabilities      `json:"ui"`
}

type dataSourceCapabilityProfile struct {
	Query               DataSourceOperationCapability `json:"query"`
	Metadata            DataSourceOperationCapability `json:"metadata"`
	Transaction         DataSourceOperationCapability `json:"transaction"`
	Pagination          DataSourceOperationCapability `json:"pagination"`
	Cancel              DataSourceOperationCapability `json:"cancel"`
	Schema              DataSourceOperationCapability `json:"schema"`
	Sampling            DataSourceOperationCapability `json:"sampling"`
	Streaming           DataSourceOperationCapability `json:"streaming"`
	DangerousOperations DataSourceOperationCapability `json:"dangerousOperations"`
	UI                  DataSourceUICapabilities      `json:"ui"`
}

type dataSourceCapabilityRegistry struct {
	Version  int                                    `json:"version"`
	Profiles map[string]dataSourceCapabilityProfile `json:"profiles"`
	Drivers  map[string]string                      `json:"drivers"`
}

//go:embed data_source_capability_contract.json
var embeddedDataSourceCapabilityContract []byte

var sharedDataSourceCapabilityRegistry = mustLoadDataSourceCapabilityRegistry()

func mustLoadDataSourceCapabilityRegistry() dataSourceCapabilityRegistry {
	registry := dataSourceCapabilityRegistry{}
	if err := json.Unmarshal(embeddedDataSourceCapabilityContract, &registry); err != nil {
		panic(fmt.Sprintf("解析数据源能力契约失败: %v", err))
	}
	if err := validateDataSourceCapabilityRegistry(registry); err != nil {
		panic(fmt.Sprintf("数据源能力契约无效: %v", err))
	}
	return registry
}

func validateDataSourceCapabilityRegistry(registry dataSourceCapabilityRegistry) error {
	if registry.Version != 1 {
		return fmt.Errorf("unsupported version %d", registry.Version)
	}
	if len(registry.Profiles) == 0 {
		return fmt.Errorf("profiles is empty")
	}
	for _, requiredProfile := range []string{dataSourceCapabilityCustomProfile, dataSourceCapabilityUnknownProfile} {
		if _, ok := registry.Profiles[requiredProfile]; !ok {
			return fmt.Errorf("missing required profile %q", requiredProfile)
		}
	}
	for profileName, profile := range registry.Profiles {
		if strings.TrimSpace(profileName) == "" {
			return fmt.Errorf("profile name is empty")
		}
		for operationName, operation := range profileOperations(profile) {
			if operation.Supported {
				continue
			}
			if strings.TrimSpace(operation.Reason) == "" {
				return fmt.Errorf("profile %q operation %q is unsupported without a reason", profileName, operationName)
			}
			if strings.TrimSpace(operation.Alternative) == "" {
				return fmt.Errorf("profile %q operation %q is unsupported without an alternative", profileName, operationName)
			}
			if strings.TrimSpace(operation.MessageKey) == "" {
				return fmt.Errorf("profile %q operation %q is unsupported without a user-facing message", profileName, operationName)
			}
		}
	}
	if len(registry.Drivers) == 0 {
		return fmt.Errorf("drivers is empty")
	}
	for driverType, profileName := range registry.Drivers {
		if normalized := normalizeRuntimeDriverType(driverType); normalized != driverType {
			return fmt.Errorf("driver %q must use normalized type %q", driverType, normalized)
		}
		if _, ok := registry.Profiles[profileName]; !ok {
			return fmt.Errorf("driver %q references unknown profile %q", driverType, profileName)
		}
	}
	return nil
}

func profileOperations(profile dataSourceCapabilityProfile) map[string]DataSourceOperationCapability {
	return map[string]DataSourceOperationCapability{
		"query":               profile.Query,
		"metadata":            profile.Metadata,
		"transaction":         profile.Transaction,
		"pagination":          profile.Pagination,
		"cancel":              profile.Cancel,
		"schema":              profile.Schema,
		"sampling":            profile.Sampling,
		"streaming":           profile.Streaming,
		"dangerousOperations": profile.DangerousOperations,
	}
}

// NormalizeDataSourceType returns the registry key for a driver type or one
// of its accepted aliases. Keep aliases here in lock-step with the capability
// table instead of making frontend and backend entry points guess separately.
func NormalizeDataSourceType(driverType string) string {
	return normalizeRuntimeDriverType(driverType)
}

// ResolveDataSourceCapability returns the declared contract for a built-in or
// Driver Agent data source. Unknown non-custom types fail closed so adding a
// driver requires an explicit registry entry and a CI update.
func ResolveDataSourceCapability(driverType string) DataSourceCapability {
	return resolveDataSourceCapability(NormalizeDataSourceType(driverType), false)
}

// ResolveCustomDataSourceCapability preserves the existing custom-driver
// workflow: an unknown custom driver remains runtime-probed instead of being
// treated as a first-class built-in data source.
func ResolveCustomDataSourceCapability(driverType string) DataSourceCapability {
	return resolveDataSourceCapability(NormalizeDataSourceType(driverType), true)
}

// IsDataSourceCapabilityDeclared reports whether a normalized driver has an
// explicit registry entry. It is used by contract tests to prevent a runtime
// driver from silently bypassing capability declaration.
func IsDataSourceCapabilityDeclared(driverType string) bool {
	_, ok := sharedDataSourceCapabilityRegistry.Drivers[NormalizeDataSourceType(driverType)]
	return ok
}

func resolveDataSourceCapability(normalizedType string, customFallback bool) DataSourceCapability {
	resolvedType := strings.TrimSpace(normalizedType)
	if resolvedType == "" {
		if customFallback {
			resolvedType = dataSourceCapabilityCustomProfile
		} else {
			resolvedType = dataSourceCapabilityUnknownProfile
		}
	}
	profileName, declared := sharedDataSourceCapabilityRegistry.Drivers[resolvedType]
	if !declared {
		if customFallback {
			profileName = dataSourceCapabilityCustomProfile
		} else {
			profileName = dataSourceCapabilityUnknownProfile
		}
	}
	profile := sharedDataSourceCapabilityRegistry.Profiles[profileName]
	return DataSourceCapability{
		Type:                resolvedType,
		Query:               profile.Query,
		Metadata:            profile.Metadata,
		Transaction:         profile.Transaction,
		Pagination:          profile.Pagination,
		Cancel:              profile.Cancel,
		Schema:              profile.Schema,
		Sampling:            profile.Sampling,
		Streaming:           profile.Streaming,
		DangerousOperations: profile.DangerousOperations,
		UI:                  profile.UI,
	}
}
