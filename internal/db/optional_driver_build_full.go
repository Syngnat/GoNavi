//go:build gonavi_full_drivers

package db

func optionalGoDriverBuildIncluded(driverType string) bool {
	_, ok := optionalGoDrivers[normalizeRuntimeDriverType(driverType)]
	return ok
}

