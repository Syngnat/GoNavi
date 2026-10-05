package runharness

import (
	"encoding/json"
	"unicode/utf8"
)

// The workspace snapshot is context, not part of the conversation: the desktop
// publishes every open tab with its draft, SQL history, saved queries, snippets
// and shortcuts, which easily outgrows a small model window by itself. A run
// must not die because of that, so a snapshot that does not fit is trimmed in a
// fixed order of increasing loss until it does.
//
// What the person attached on purpose (a selected piece of SQL, table schemas)
// is the last thing to go: it is cut down to fit, never dropped whole. Nor is the
// active connection and database, while it fits at all: without it the model
// cannot address its tools.
//
// Trimming only changes the provider-facing projection. The stored snapshot and
// the reference to it are untouched.

// Workspace trim levels, in order of increasing loss. "" means the full snapshot.
const (
	WorkspaceTrimEssential   = "essential"   // drops history, saved queries, snippets, shortcuts and the other tabs' drafts
	WorkspaceTrimActiveTab   = "active_tab"  // keeps the active tab (no draft) and the attached context
	WorkspaceTrimAttachments = "attachments" // keeps the attached context, cutting items down to what fits
	WorkspaceTrimMinimal     = "minimal"     // keeps only the active connection and database
	WorkspaceTrimOmitted     = "omitted"     // sends no workspace message at all
)

const (
	// The workspace as a whole (tabs, history, snippets, shortcuts: background the
	// model rarely needs) may take this share (numerator/denominator) of the prompt
	// budget. The conversation, and what the person bound on purpose, matter more,
	// and every byte of prompt is minutes of waiting on a small hosted model.
	workspaceBudgetNumerator   = 1
	workspaceBudgetDenominator = 4
	// What the person bound on purpose (a selection, quoted text, table schemas) is
	// the last thing to go: it may take most of the budget, cut down to fit rather
	// than dropped.
	attachedBudgetNumerator   = 17
	attachedBudgetDenominator = 20
	// essentialDraftBytes bounds the one draft kept at the first trim level.
	essentialDraftBytes = 1200
	// minUsefulItemBytes is the least of an attached item worth sending.
	minUsefulItemBytes = 160
	// attachedTruncationMarker tells the model, and the person reading a log,
	// that the text was cut.
	attachedTruncationMarker = "\n/* ... truncated to fit the model's context window ... */"
)

type workspaceCandidate struct {
	level    string
	snapshot WorkspaceSnapshot
}

// workspaceFit is the chosen projection of the workspace.
type workspaceFit struct {
	message  Message
	included bool
	trimmed  string
}

func shareOfLimit(limit, numerator, denominator int) int {
	if limit <= 0 {
		return 0
	}
	return limit * numerator / denominator
}

// fitWorkspace returns the richest projection of the snapshot that fits the
// limits and still leaves room for the newest durable message. fixed is what is
// sent regardless (the standing instructions): it does not shrink the
// workspace's share of the budget, but the whole still has to fit. With no
// limits configured the full snapshot is always returned.
func (b *DeterministicContextBuilder) fitWorkspace(snapshot *WorkspaceSnapshot, reference *WorkspaceSnapshotReference, newest *Message, fixed contextMessageSizeResult, maxTokens int, estimate TokenEstimator) (workspaceFit, error) {
	if snapshot == nil {
		return workspaceFit{}, nil
	}
	newestBytes, newestTokens := fixed.bytes, fixed.tokens
	if newest != nil {
		size := measureContextMessage(*newest, estimate)
		newestBytes += size.bytes
		newestTokens += size.tokens
	}
	// try measures one candidate against its share of the budget; it returns the
	// message when it fits.
	try := func(candidate WorkspaceSnapshot, level string, numerator, denominator int) (Message, bool, error) {
		message, has, err := workspaceContextMessage(&candidate, reference, level)
		if err != nil || !has {
			return Message{}, false, err
		}
		size := measureContextMessage(message, estimate)
		if contextLimitExceeded(size.bytes, size.tokens, shareOfLimit(b.MaxBytes, numerator, denominator), shareOfLimit(maxTokens, numerator, denominator)) {
			return Message{}, false, nil
		}
		return message, !contextLimitExceeded(size.bytes+newestBytes, size.tokens+newestTokens, b.MaxBytes, maxTokens), nil
	}

	for _, candidate := range wholeWorkspaceLevels(*snapshot) {
		message, ok, err := try(candidate.snapshot, candidate.level, workspaceBudgetNumerator, workspaceBudgetDenominator)
		if err != nil {
			return workspaceFit{}, err
		}
		if ok {
			return workspaceFit{message: message, included: true, trimmed: candidate.level}, nil
		}
	}

	base := minimalWorkspace(*snapshot)
	if items := attachedItems(snapshot.ActiveContext); len(items) > 0 {
		fitted, err := fitAttachedItems(base, items, func(candidate WorkspaceSnapshot) (bool, error) {
			_, ok, err := try(candidate, WorkspaceTrimAttachments, attachedBudgetNumerator, attachedBudgetDenominator)
			return ok, err
		})
		if err != nil {
			return workspaceFit{}, err
		}
		if fitted != nil {
			message, _, err := try(*fitted, WorkspaceTrimAttachments, attachedBudgetNumerator, attachedBudgetDenominator)
			if err != nil {
				return workspaceFit{}, err
			}
			return workspaceFit{message: message, included: true, trimmed: WorkspaceTrimAttachments}, nil
		}
	}
	base.ActiveContext = withAttachedItems(snapshot.ActiveContext, nil)
	// The connection line is small in content but carries the snapshot's envelope, which alone
	// outgrows the background share of a 4k window: it may take the share the attachments get.
	if message, ok, err := try(base, WorkspaceTrimMinimal, attachedBudgetNumerator, attachedBudgetDenominator); err != nil {
		return workspaceFit{}, err
	} else if ok {
		return workspaceFit{message: message, included: true, trimmed: WorkspaceTrimMinimal}, nil
	}
	return workspaceFit{trimmed: WorkspaceTrimOmitted}, nil
}

// wholeWorkspaceLevels lists the projections that keep the attached context
// intact, richest first.
func wholeWorkspaceLevels(full WorkspaceSnapshot) []workspaceCandidate {
	essential := full
	essential.SQLActivity, essential.SavedQueries, essential.Snippets = nil, nil, nil
	essential.ExternalSQLDirectories, essential.Shortcuts = nil, nil
	essential.TransactionState, essential.Diagnostics = nil, nil
	essential.Tabs = tabsWithoutDrafts(full.Tabs, full.ActiveTabID, essentialDraftBytes)

	activeTab := essential
	activeTab.Tabs = activeTabOnly(full.Tabs, full.ActiveTabID)
	activeTab.Capabilities, activeTab.Availability = nil, nil

	return []workspaceCandidate{
		{level: "", snapshot: full},
		{level: WorkspaceTrimEssential, snapshot: essential},
		{level: WorkspaceTrimActiveTab, snapshot: activeTab},
	}
}

// minimalWorkspace keeps what identifies the active connection and database and
// nothing else, with the attached items removed for the caller to add back.
func minimalWorkspace(full WorkspaceSnapshot) WorkspaceSnapshot {
	minimal := full
	minimal.SQLActivity, minimal.SavedQueries, minimal.Snippets = nil, nil, nil
	minimal.ExternalSQLDirectories, minimal.Shortcuts = nil, nil
	minimal.TransactionState, minimal.Diagnostics = nil, nil
	minimal.Capabilities, minimal.Availability = nil, nil
	minimal.Tabs = nil
	minimal.ActiveContext = withAttachedItems(full.ActiveContext, nil)
	return minimal
}

// fitAttachedItems puts as much of the attached context as fits into base. What
// the person picked by hand (an editor selection, a quoted passage) goes first,
// then table schemas in the order they were attached. An item that does not fit whole is cut down; only one
// that cannot keep a useful amount is skipped. It returns nil when not even the
// bare base fits.
func fitAttachedItems(base WorkspaceSnapshot, items []any, fits func(WorkspaceSnapshot) (bool, error)) (*WorkspaceSnapshot, error) {
	if ok, err := fits(base); err != nil || !ok {
		return nil, err
	}
	type pending struct {
		index int
		item  any
	}
	ordered := make([]pending, 0, len(items))
	for i, item := range items {
		if isPickedByHand(item) {
			ordered = append(ordered, pending{i, item})
		}
	}
	for i, item := range items {
		if !isPickedByHand(item) {
			ordered = append(ordered, pending{i, item})
		}
	}

	var kept []pending
	with := func(extra pending) WorkspaceSnapshot {
		all := append(append([]pending(nil), kept...), extra)
		// Back in the order they were attached.
		for i := 1; i < len(all); i++ {
			for j := i; j > 0 && all[j].index < all[j-1].index; j-- {
				all[j], all[j-1] = all[j-1], all[j]
			}
		}
		list := make([]any, len(all))
		for i, entry := range all {
			list[i] = entry.item
		}
		trial := base
		trial.ActiveContext = withAttachedItems(base.ActiveContext, list)
		return trial
	}
	for _, entry := range ordered {
		if ok, err := fits(with(entry)); err != nil {
			return nil, err
		} else if ok {
			kept = append(kept, entry)
			continue
		}
		// Too big whole: find the longest cut that still fits.
		longest := longestItemText(entry.item)
		low, high, best := 0, longest, -1
		for low <= high {
			mid := (low + high) / 2
			ok, err := fits(with(pending{entry.index, truncateItem(entry.item, mid)}))
			if err != nil {
				return nil, err
			}
			if ok {
				best, low = mid, mid+1
			} else {
				high = mid - 1
			}
		}
		if best >= minUsefulItemBytes {
			kept = append(kept, pending{entry.index, truncateItem(entry.item, best)})
			break // nothing more fits after a cut item
		}
	}
	if len(kept) == 0 {
		return nil, nil
	}
	final := with(kept[len(kept)-1])
	// with() appended the last entry a second time; rebuild from kept only.
	all := append([]pending(nil), kept...)
	for i := 1; i < len(all); i++ {
		for j := i; j > 0 && all[j].index < all[j-1].index; j-- {
			all[j], all[j-1] = all[j-1], all[j]
		}
	}
	list := make([]any, len(all))
	for i, entry := range all {
		list[i] = entry.item
	}
	final.ActiveContext = withAttachedItems(base.ActiveContext, list)
	return &final, nil
}

func isPickedByHand(item any) bool {
	entry, ok := item.(map[string]any)
	return ok && (entry["kind"] == "editor_selection" || entry["kind"] == "chat_quote")
}

// itemTextField is the field that carries an item's bulk: a selection's text or
// a table's DDL.
func itemTextField(entry map[string]any) string {
	if text, _ := entry["content"].(string); text != "" {
		return "content"
	}
	return "ddl"
}

func longestItemText(item any) int {
	entry, ok := item.(map[string]any)
	if !ok {
		return 0
	}
	text, _ := entry[itemTextField(entry)].(string)
	return len(text)
}

// truncateItem returns a copy of item with its text cut to at most limit bytes
// plus a marker.
func truncateItem(item any, limit int) any {
	entry, ok := item.(map[string]any)
	if !ok {
		return item
	}
	field := itemTextField(entry)
	text, _ := entry[field].(string)
	if len(text) <= limit {
		return item
	}
	copied := make(map[string]any, len(entry)+1)
	for key, value := range entry {
		copied[key] = value
	}
	copied[field] = truncateUTF8(text, limit) + attachedTruncationMarker
	copied["truncated"] = true
	return copied
}

func tabsWithoutDrafts(tabs []WorkspaceTab, activeID string, activeDraftBytes int) []WorkspaceTab {
	if len(tabs) == 0 {
		return nil
	}
	trimmed := make([]WorkspaceTab, len(tabs))
	for i, tab := range tabs {
		tab.Draft = ""
		if tab.ID == activeID {
			tab.Draft = truncateUTF8(tabs[i].Draft, activeDraftBytes)
		}
		trimmed[i] = tab
	}
	return trimmed
}

func activeTabOnly(tabs []WorkspaceTab, activeID string) []WorkspaceTab {
	for _, tab := range tabs {
		if tab.ID == activeID {
			tab.Draft = ""
			return []WorkspaceTab{tab}
		}
	}
	return nil
}

// truncateUTF8 cuts at a character boundary, never inside a multi-byte rune.
func truncateUTF8(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	return value[:limit]
}

// attachedItems reads activeContext.attachedItems whichever Go type the value
// arrived as (decoded JSON is []any; in-process callers may use typed slices).
// Typed entries are normalized to generic maps so every caller sees one shape.
func attachedItems(activeContext map[string]any) []any {
	raw, ok := activeContext["attachedItems"]
	if !ok || raw == nil {
		return nil
	}
	if items, ok := raw.([]any); ok {
		return items
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var items []any
	if json.Unmarshal(encoded, &items) != nil {
		return nil
	}
	return items
}

func withAttachedItems(activeContext map[string]any, items []any) map[string]any {
	if activeContext == nil {
		return nil
	}
	copied := make(map[string]any, len(activeContext))
	for key, value := range activeContext {
		copied[key] = value
	}
	if len(items) == 0 {
		delete(copied, "attachedItems")
	} else {
		copied["attachedItems"] = append([]any(nil), items...)
	}
	return copied
}
