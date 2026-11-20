package app

import (
	"errors"
	"fmt"
	"testing"

	"GoNavi-Wails/internal/scriptlib"
)

func TestScriptWorkbenchFailureCarriesStableCodeAndKind(t *testing.T) {
	tests := []struct {
		name string
		err  error
		code string
	}{
		{name: "revision conflict", err: fmt.Errorf("save: %w", scriptlib.ErrConflict), code: "revision_conflict"},
		{name: "forbidden", err: scriptlib.ErrForbidden, code: "forbidden"},
		{name: "not found", err: scriptlib.ErrNotFound, code: "item_not_found"},
		{name: "invalid", err: scriptlib.ErrInvalid, code: "invalid_input"},
		{name: "upload missing", err: fmt.Errorf("input: %w", ErrWebTransferNotFound), code: "invalid_input"},
		{name: "backend unavailable", err: errScriptWorkbenchUnavailable, code: "backend_unavailable"},
		{name: "run missing", err: errScriptWorkbenchRunNotFound, code: "run_not_found"},
		{name: "approval", err: errors.New("production write approval token is required"), code: "write_confirmation_required"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := scriptWorkbenchFailure(test.err)
			if result.Success || result.Code != test.code || result.Kind != "backend" {
				t.Fatalf("result = %+v, want code %q backend", result, test.code)
			}
		})
	}
}
