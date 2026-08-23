//go:build gonavi_full_drivers || gonavi_mariadb_driver

package db

import (
	"context"
	"errors"
	"io"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestMariaDBApplyChangesMarksAmbiguousDMLResponseOutcomeUnknown(t *testing.T) {
	for name, testCase := range map[string]struct {
		writeErr error
		changes  connection.ChangeSet
	}{
		"delete transport":    {writeErr: io.ErrUnexpectedEOF, changes: connection.ChangeSet{Deletes: []map[string]interface{}{{"id": int64(1)}}}},
		"insert transport":    {writeErr: io.ErrUnexpectedEOF, changes: connection.ChangeSet{Inserts: []map[string]interface{}{{"id": int64(1)}}}},
		"delete cancellation": {writeErr: context.Canceled, changes: connection.ChangeSet{Deletes: []map[string]interface{}{{"id": int64(1)}}}},
	} {
		t.Run(name, func(t *testing.T) {
			state := &writeOutcomeTransactionState{execErr: testCase.writeErr}
			database := openWriteOutcomeTransactionDB(t, state)

			err := (&MariaDB{conn: database}).ApplyChangesContext(context.Background(), "users", testCase.changes)
			if !IsWriteOutcomeUnknown(err) || !errors.Is(err, testCase.writeErr) {
				t.Fatalf("ambiguous DML response must mark the outcome unknown for non-transactional tables, got %v", err)
			}
		})
	}
}

func TestMariaDBApplyChangesKeepsSemanticDMLRejectionKnown(t *testing.T) {
	state := &writeOutcomeTransactionState{execErr: errors.New("constraint rejected")}
	database := openWriteOutcomeTransactionDB(t, state)

	err := (&MariaDB{conn: database}).ApplyChangesContext(context.Background(), "users", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": int64(1)}},
	})
	if err == nil || IsWriteOutcomeUnknown(err) {
		t.Fatalf("semantic DML rejection must remain a known error, got %v", err)
	}
}
