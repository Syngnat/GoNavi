package runharness

import (
	"encoding/json"
	"strings"
)

// ContextChipMediaType marks a user-message attachment that records what the
// person bound when sending: an editor selection, an attached table schema, or a
// passage quoted from an earlier answer. The desktop shows it as a chip.
//
// The live workspace snapshot cannot be the only carrier: it is read fresh for
// each model turn, and the desktop clears what it bound as soon as the message is
// sent (and republishes the snapshot). So the context rides with the message, and
// the projection of the newest user message merges it back in.
const ContextChipMediaType = "application/vnd.gonavi.context+json"

type contextChipPayload struct {
	V         int    `json:"v"`
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	Text      string `json:"text"`
	DBName    string `json:"dbName"`
	TableName string `json:"tableName"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
}

// withMessageContext returns the snapshot with the newest user message's context
// chips merged into activeContext.attachedItems. Items the snapshot already holds
// (same kind, same text) are not repeated. The caller's snapshot is not modified.
func withMessageContext(snapshot *WorkspaceSnapshot, transcript []Message) *WorkspaceSnapshot {
	if snapshot == nil {
		return nil
	}
	chips := latestUserContextChips(transcript)
	if len(chips) == 0 {
		return snapshot
	}
	items := attachedItems(snapshot.ActiveContext)
	known := make(map[string]bool, len(items))
	for _, item := range items {
		if entry, ok := item.(map[string]any); ok {
			known[itemIdentity(entry)] = true
		}
	}
	merged := append([]any(nil), items...)
	for _, chip := range chips {
		entry := chipToItem(chip)
		if identity := itemIdentity(entry); !known[identity] {
			known[identity] = true
			merged = append(merged, entry)
		}
	}
	if len(merged) == len(items) {
		return snapshot
	}
	copied := *snapshot
	active := snapshot.ActiveContext
	if active == nil {
		active = map[string]any{}
	}
	copied.ActiveContext = withAttachedItems(active, merged)
	return &copied
}

func latestUserContextChips(transcript []Message) []contextChipPayload {
	for i := len(transcript) - 1; i >= 0; i-- {
		if transcript[i].Role != "user" {
			continue
		}
		var chips []contextChipPayload
		for _, attachment := range transcript[i].Attachments {
			if attachment.MediaType != ContextChipMediaType {
				continue
			}
			var payload contextChipPayload
			if json.Unmarshal([]byte(attachment.Data), &payload) != nil || payload.V != 1 || strings.TrimSpace(payload.Text) == "" {
				continue
			}
			switch payload.Kind {
			case "editor_selection", "table_schema", "chat_quote":
				chips = append(chips, payload)
			}
		}
		return chips
	}
	return nil
}

// chipToItem is the attachedItems entry the desktop itself would have published
// for the same binding.
func chipToItem(chip contextChipPayload) map[string]any {
	switch chip.Kind {
	case "table_schema":
		return map[string]any{"dbName": chip.DBName, "tableName": chip.TableName, "ddl": chip.Text}
	case "chat_quote":
		return map[string]any{"kind": "chat_quote", "dbName": chip.DBName, "tableName": "__gonavi_chat_quote__", "ddl": "", "label": chip.Label, "content": chip.Text}
	}
	item := map[string]any{"kind": "editor_selection", "dbName": chip.DBName, "tableName": "__gonavi_editor_selection__", "ddl": "", "label": chip.Label, "content": chip.Text}
	if chip.StartLine > 0 && chip.EndLine >= chip.StartLine {
		item["source"] = map[string]any{"startLine": float64(chip.StartLine), "endLine": float64(chip.EndLine)}
	}
	return item
}

// itemIdentity is what makes two entries the same binding: its kind and text.
func itemIdentity(entry map[string]any) string {
	kind, _ := entry["kind"].(string)
	text, _ := entry[itemTextField(entry)].(string)
	return kind + "\x00" + strings.TrimSpace(text)
}
