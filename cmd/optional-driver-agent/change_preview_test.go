package main

import (
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type previewingDatabase struct{ db.Database }

func (previewingDatabase) PreviewChanges(tableName string, changes connection.ChangeSet) ([]string, []string, []string) {
	return []string{"DELETE " + tableName}, nil, []string{"POST " + tableName}
}

func TestHandlePreviewChangesForwardsDriverPreview(t *testing.T) {
	changes := &connection.ChangeSet{}
	resp := handlePreviewChanges(previewingDatabase{}, agentRequest{TableName: "books", Changes: changes}, agentResponse{Success: true})
	preview, ok := resp.Data.(agentChangePreview)
	if !resp.Success || !ok || !preview.Supported || preview.Deletes[0] != "DELETE books" || preview.Inserts[0] != "POST books" {
		t.Fatalf("response = %#v", resp)
	}

	resp = handlePreviewChanges(struct{ db.Database }{}, agentRequest{TableName: "books", Changes: changes}, agentResponse{Success: true})
	if preview, ok := resp.Data.(agentChangePreview); !resp.Success || !ok || preview.Supported {
		t.Fatalf("drivers without a previewer must report unsupported: %#v", resp)
	}

	if resp := handlePreviewChanges(previewingDatabase{}, agentRequest{TableName: "books"}, agentResponse{Success: true}); resp.Success {
		t.Fatal("a missing change set must fail")
	}
}
