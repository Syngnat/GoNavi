package app

import (
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// savedConnectionImportReport is the outcome of a user-triggered connection
// import: the connections that were written, and how many source entries were
// left out because the same connection is already saved or appeared earlier
// in the same file.
type savedConnectionImportReport struct {
	Views   []connection.SavedConnectionView
	Skipped int
}

const connectionImportIdentitySeparator = "\x1f"

// connectionImportIdentity returns the key that decides whether two entries
// describe the same connection for import purposes.
//
// It is built only from what a user recognises a connection by. Tuning and
// cosmetic fields (timeouts, SSL mode, icons, ...) are left out on purpose:
// the edit form rewrites their defaults on save, and that must not make the
// next import of the same file look like a new connection.
func connectionImportIdentity(name string, config connection.ConnectionConfig) string {
	parts := []string{
		strings.TrimSpace(name),
		normalizeDriverType(config.Type),
		strings.ToLower(strings.TrimSpace(config.Driver)),
		strings.ToLower(strings.TrimSpace(config.Host)),
		strconv.Itoa(config.Port),
		strings.TrimSpace(config.User),
		strings.TrimSpace(config.Database),
	}
	for _, host := range config.Hosts {
		parts = append(parts, "host="+strings.ToLower(strings.TrimSpace(host)))
	}
	// The same 127.0.0.1:3306 reached through different jump hosts is a
	// different server, so the tunnel endpoint is part of the identity.
	if config.UseSSH {
		parts = append(parts,
			"ssh="+strings.ToLower(strings.TrimSpace(config.SSH.Host)),
			strconv.Itoa(config.SSH.Port),
			strings.TrimSpace(config.SSH.User),
		)
	}
	return strings.Join(parts, connectionImportIdentitySeparator)
}

// connectionImportBatchKey extends the identity with the opaque DSN/URI an
// input carries, so two DSN-only rows that share a name stay distinct.
func connectionImportBatchKey(input connection.SavedConnectionInput) string {
	return strings.Join([]string{
		connectionImportIdentity(input.Name, input.Config),
		strings.TrimSpace(input.Config.DSN),
		strings.TrimSpace(input.Config.URI),
	}, connectionImportIdentitySeparator)
}

// hasSavedImportDuplicate reports whether one of the saved candidates (which
// already share the input's identity) is the same connection as input. The
// stored DSN/URI are only consulted when the input supplies one, because a
// file exported without secrets cannot be told apart by them.
func (r *savedConnectionRepository) hasSavedImportDuplicate(
	candidates []connection.SavedConnectionView,
	input connection.SavedConnectionInput,
) bool {
	if len(candidates) == 0 {
		return false
	}
	dsn := strings.TrimSpace(input.Config.DSN)
	uri := strings.TrimSpace(input.Config.URI)
	if dsn == "" && uri == "" {
		return true
	}
	for _, candidate := range candidates {
		bundle, err := r.loadSecretBundle(candidate)
		if err != nil {
			// An unreadable secret cannot prove the two are the same; importing
			// a possible duplicate is safer than silently dropping the entry.
			continue
		}
		sameDSN := dsn == "" || strings.TrimSpace(bundle.OpaqueDSN) == dsn
		sameURI := uri == "" || strings.TrimSpace(bundle.OpaqueURI) == uri
		if sameDSN && sameURI {
			return true
		}
	}
	return false
}

// filterDuplicateImportedConnections drops prepared inputs that would add a
// second copy of a connection and returns how many were dropped.
//
// An input whose ID is already saved is an in-place update and is always
// kept, which preserves the "package wins" restore semantics. A new input is
// dropped when an earlier kept input, or a saved connection this batch does
// not overwrite, is the same connection.
func (r *savedConnectionRepository) filterDuplicateImportedConnections(
	saved []connection.SavedConnectionView,
	inputs []connection.SavedConnectionInput,
) ([]connection.SavedConnectionInput, int) {
	savedIDs := make(map[string]struct{}, len(saved))
	for _, view := range saved {
		savedIDs[view.ID] = struct{}{}
	}

	overwritten := make(map[string]struct{})
	taken := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if _, ok := savedIDs[input.ID]; ok {
			overwritten[input.ID] = struct{}{}
			taken[connectionImportBatchKey(input)] = struct{}{}
		}
	}

	savedByIdentity := make(map[string][]connection.SavedConnectionView, len(saved))
	for _, view := range saved {
		if _, ok := overwritten[view.ID]; ok {
			continue
		}
		identity := connectionImportIdentity(view.Name, view.Config)
		savedByIdentity[identity] = append(savedByIdentity[identity], view)
	}

	kept := make([]connection.SavedConnectionInput, 0, len(inputs))
	skipped := 0
	for _, input := range inputs {
		if _, ok := overwritten[input.ID]; ok {
			kept = append(kept, input)
			continue
		}
		batchKey := connectionImportBatchKey(input)
		_, seen := taken[batchKey]
		if seen || r.hasSavedImportDuplicate(savedByIdentity[connectionImportIdentity(input.Name, input.Config)], input) {
			skipped++
			continue
		}
		taken[batchKey] = struct{}{}
		kept = append(kept, input)
	}
	return kept, skipped
}

// importSavedConnectionsSkippingDuplicates is the import used by every
// user-triggered file import (package, Excel, Workbench, Navicat, legacy
// JSON). Unlike cloud restore, which must reproduce a snapshot exactly, it
// never creates a second copy of a connection the user already has.
func (a *App) importSavedConnectionsSkippingDuplicates(
	inputs []connection.SavedConnectionInput,
) (savedConnectionImportReport, error) {
	repo := a.savedConnectionRepository()
	var report savedConnectionImportReport
	err := repo.withWriteLock(func() error {
		prepared, err := prepareImportedSavedConnectionInputs(inputs)
		if err != nil {
			return err
		}
		saved, err := repo.load()
		if err != nil {
			return err
		}
		kept, skipped := repo.filterDuplicateImportedConnections(saved, prepared)
		views, err := a.savePreparedConnectionImportUnlocked(repo, kept)
		if err != nil {
			return err
		}
		report = savedConnectionImportReport{Views: views, Skipped: skipped}
		return nil
	})
	if err != nil {
		return savedConnectionImportReport{}, err
	}
	if len(report.Views) > 0 {
		a.markCloudBackupDirty()
	}
	return report, nil
}

func connectionPackageImportResultFromReport(
	report savedConnectionImportReport,
	redisDbAliases map[string]map[string]string,
) ConnectionPackageImportResult {
	result := connectionPackageImportResultFromViews(report.Views, redisDbAliases)
	result.SkippedCount = report.Skipped
	return result
}
