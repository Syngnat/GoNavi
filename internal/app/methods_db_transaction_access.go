package app

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/webidentity"
)

func viewerReadOnlyConnectionConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	config.ReadOnly = true
	config.Protection = connection.ConnectionProtectionConfig{
		RestrictDataEdit:        true,
		RestrictStructureEdit:   true,
		RestrictScriptExecution: true,
		RestrictDataImport:      true,
	}
	return config
}

func (a *App) managedTransactionOwner(ctx context.Context) string {
	if a == nil || !a.webRuntime {
		return ""
	}
	return webidentity.UsernameFromContext(ctx)
}

// authorizeManagedTransactionStart validates the request-scoped part of opening
// a transaction. The desktop runtime has no cross-user boundary; Web requests
// must carry an authenticated actor and obey the connection ACL.
func (a *App) authorizeManagedTransactionStart(
	ctx context.Context,
	config connection.ConnectionConfig,
	query string,
) error {
	if a == nil || !a.webRuntime {
		return nil
	}
	actor, ok := webidentity.ActorFromContext(ctx)
	if !ok {
		return errors.New("authenticated web user is required")
	}
	if err := enforceManagedTransactionConnectionACL(actor, config.ID); err != nil {
		return err
	}
	if actor.Role == webidentity.RoleViewer {
		if !SupportsConnectionReadOnlyMode(config) {
			return fmt.Errorf("read-only user cannot use data source %q", strings.TrimSpace(config.Type))
		}
		config = viewerReadOnlyConnectionConfig(config)
	}
	return ensureConnectionAllowsQuery(config, query)
}

// authorizeManagedSQLTransactionAccess authorizes a follow-up statement,
// commit, or rollback. Transaction IDs are opaque but not capabilities: the
// actor must own the transaction and still be allowed to use its connection.
func (a *App) authorizeManagedSQLTransactionAccess(
	ctx context.Context,
	tx *managedSQLTransaction,
	query string,
) error {
	if a == nil || !a.webRuntime {
		return nil
	}
	if tx == nil {
		return errors.New("transaction is unavailable")
	}
	actor, ok := webidentity.ActorFromContext(ctx)
	if !ok {
		return errors.New("authenticated web user is required")
	}
	owner := webidentity.NormalizeUsername(tx.owner)
	if owner == "" || owner != actor.Username {
		return fmt.Errorf("transaction %q is not accessible for this user", strings.TrimSpace(tx.id))
	}
	if err := enforceManagedTransactionConnectionACL(actor, tx.config.ID); err != nil {
		return err
	}
	config := tx.config
	if strings.TrimSpace(config.Type) == "" {
		config.Type = tx.dbType
	}
	if actor.Role == webidentity.RoleViewer {
		if !SupportsConnectionReadOnlyMode(config) {
			return fmt.Errorf("read-only user cannot use data source %q", strings.TrimSpace(config.Type))
		}
		config = viewerReadOnlyConnectionConfig(config)
	}
	if strings.TrimSpace(query) == "" {
		return nil
	}
	return ensureConnectionAllowsQuery(config, query)
}

func enforceManagedTransactionConnectionACL(actor webidentity.Actor, connectionID string) error {
	if len(actor.AllowedConnectionIDs) == 0 {
		return nil
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" || !slices.Contains(actor.AllowedConnectionIDs, connectionID) {
		return fmt.Errorf("connection %q is not allowed for this user", connectionID)
	}
	return nil
}
