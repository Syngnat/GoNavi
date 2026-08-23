package db

import (
	"strings"
	"testing"
)

func TestDataSourceCapabilityRegistryDeclaresBuiltinAndDriverAgentSources(t *testing.T) {
	sources := []struct {
		name    string
		drivers map[string]struct{}
	}{
		{name: "builtin", drivers: coreBuiltinDrivers},
		{name: "driver-agent", drivers: optionalGoDrivers},
	}

	for _, source := range sources {
		for driverType := range source.drivers {
			driverType := driverType
			t.Run(source.name+"/"+driverType, func(t *testing.T) {
				if !IsDataSourceCapabilityDeclared(driverType) {
					t.Fatalf("%s driver %q is missing a data-source capability declaration", source.name, driverType)
				}

				capability := ResolveDataSourceCapability(driverType)
				if capability.Type != driverType {
					t.Fatalf("capability type = %q, want %q", capability.Type, driverType)
				}
				for operationName, operation := range dataSourceCapabilityOperations(capability) {
					if operation.Supported {
						continue
					}
					if strings.TrimSpace(operation.Reason) == "" || strings.TrimSpace(operation.Alternative) == "" || strings.TrimSpace(operation.MessageKey) == "" {
						t.Fatalf("%s driver %q operation %q is unsupported without complete guidance: %#v", source.name, driverType, operationName, operation)
					}
				}
			})
		}
	}
}

func TestDataSourceCapabilityRegistryGuidesEveryUnsupportedOperation(t *testing.T) {
	if err := validateDataSourceCapabilityRegistry(sharedDataSourceCapabilityRegistry); err != nil {
		t.Fatalf("shared capability registry validation failed: %v", err)
	}

	for profileName, profile := range sharedDataSourceCapabilityRegistry.Profiles {
		for operationName, operation := range profileOperations(profile) {
			if operation.Supported {
				continue
			}
			if strings.TrimSpace(operation.Reason) == "" {
				t.Fatalf("profile %q operation %q has no reason", profileName, operationName)
			}
			if strings.TrimSpace(operation.Alternative) == "" {
				t.Fatalf("profile %q operation %q has no alternative", profileName, operationName)
			}
			if strings.TrimSpace(operation.MessageKey) == "" {
				t.Fatalf("profile %q operation %q has no user-facing message", profileName, operationName)
			}
		}
	}
}

func TestDataSourceCapabilityUnknownTypesFailClosedAndCustomDriversProbeRuntime(t *testing.T) {
	unknown := ResolveDataSourceCapability("future-driver")
	if unknown.Query.Supported || unknown.Transaction.Supported {
		t.Fatalf("undeclared driver must fail closed, got %#v", unknown)
	}
	if unknown.Query.Reason != "capability_not_declared" || unknown.Query.Alternative != "configure-custom-driver" {
		t.Fatalf("undeclared driver guidance = %#v", unknown.Query)
	}

	custom := ResolveCustomDataSourceCapability("future-driver")
	if !custom.Query.Supported || !custom.Query.RuntimeProbe || !custom.Transaction.Supported || !custom.Transaction.RuntimeProbe {
		t.Fatalf("custom driver must preserve runtime probing, got %#v", custom)
	}
}

func dataSourceCapabilityOperations(capability DataSourceCapability) map[string]DataSourceOperationCapability {
	return map[string]DataSourceOperationCapability{
		"query":               capability.Query,
		"metadata":            capability.Metadata,
		"transaction":         capability.Transaction,
		"pagination":          capability.Pagination,
		"cancel":              capability.Cancel,
		"schema":              capability.Schema,
		"sampling":            capability.Sampling,
		"streaming":           capability.Streaming,
		"dangerousOperations": capability.DangerousOperations,
	}
}
