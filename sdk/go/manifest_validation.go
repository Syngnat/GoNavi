package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ValidateManifest applies every rule the host enforces before a package may be
// installed, so a marketplace can reject a package a released host would refuse.
//
// This is the single implementation of the manifest contract. The host and the
// marketplace previously each kept a copy and drifted three times: the host
// dropped configSchema while the marketplace kept accepting it, the host added
// panels[].html while the marketplace kept rejecting it, and the host tightened
// the window permission while the marketplace did not follow. Each drift
// published packages that no released host could parse.
//
// Validation is pure: it reads the declaration only and never executes or
// resolves anything the package names.
func ValidateManifest(m Manifest) error {
	if m.SchemaVersion != 1 || m.APIVersion != 1 {
		return errors.New("unsupported plugin schema or api version")
	}
	if !validManifestPluginID(m.ID) || !validManifestText(m.Name, 256) || !validManifestVersion(m.Version) {
		return errors.New("invalid plugin id, name, or version")
	}
	if len(m.Description) > 16384 || len(m.Author) > 512 || len(m.License) > 256 {
		return errors.New("plugin metadata exceeds limit")
	}
	if m.MinHostVersion != "" && !validManifestVersion(m.MinHostVersion) {
		return errors.New("invalid minimum host version")
	}
	if m.Icon != "" && !validManifestIcon(m.Icon) {
		return errors.New("invalid plugin icon path")
	}
	if len(m.Permissions) > 64 || len(m.Requires) > 64 {
		return errors.New("too many permissions or dependencies")
	}
	seen := make(map[string]bool, len(m.Permissions))
	for _, permission := range m.Permissions {
		if !manifestPermissionPattern.MatchString(permission) || seen[permission] {
			return errors.New("invalid or duplicate permission")
		}
		seen[permission] = true
	}
	if err := ValidatePermissionNotes(m); err != nil {
		return err
	}
	permissions := seen
	dependencies := make(map[string]bool, len(m.Requires))
	for _, dependency := range m.Requires {
		if !validManifestPluginID(dependency.ID) || dependency.ID == m.ID || dependencies[dependency.ID] ||
			(dependency.MinVersion != "" && !validManifestVersion(dependency.MinVersion)) {
			return errors.New("invalid or duplicate dependency")
		}
		dependencies[dependency.ID] = true
	}
	if err := validateManifestBackend(m.Backend); err != nil {
		return err
	}
	// Contributions is a pointer in the SDK contract, so an absent block is nil and
	// every rule below treats it as "declares nothing".
	contributes := manifestContributions(m)
	commands, err := validateManifestCommands(contributes, m.Backend)
	if err != nil {
		return err
	}
	if err := validateManifestDataSources(m, commands); err != nil {
		return err
	}
	if err := validateManifestSkills(m); err != nil {
		return err
	}
	if err := validateManifestAIProviders(m, commands); err != nil {
		return err
	}
	if err := validateManifestExporters(m, commands); err != nil {
		return err
	}
	publicCommands := publicManifestCommands(contributes, commands)
	if err := validateManifestPanels(contributes.Panels, publicCommands, permissions); err != nil {
		return err
	}
	if err := ValidatePages(m); err != nil {
		return err
	}
	if err := validateManifestSidebar(m, permissions, publicCommands); err != nil {
		return err
	}
	if m.Window != nil {
		// A window runs package HTML/JS in a native WebView with the window bridge;
		// like a custom HTML page it needs the explicit sandboxed-HTML permission.
		if !permissions[PageCustomHTMLPermission] {
			return fmt.Errorf("window requires the %s permission", PageCustomHTMLPermission)
		}
		if err := SafePackagePath(m.Window.Entry); err != nil {
			return fmt.Errorf("invalid window entry: %w", err)
		}
		if len(m.Window.Title) > 256 || m.Window.Width < 0 || m.Window.Height < 0 || m.Window.Width > 8192 || m.Window.Height > 8192 {
			return errors.New("invalid window dimensions or title")
		}
	}
	return validateManifestConnectionActions(m, permissions)
}

func validateManifestCommands(contributes Contributions, backend *Backend) (map[string]bool, error) {
	if len(contributes.Commands) > 128 || len(contributes.Panels) > 32 {
		return nil, errors.New("too many contributions")
	}
	commands := make(map[string]bool, len(contributes.Commands))
	for _, command := range contributes.Commands {
		if !manifestLocalIDPattern.MatchString(command.ID) || commands[command.ID] ||
			!validManifestText(command.Title, 256) || len(command.Description) > 4096 {
			return nil, errors.New("invalid or duplicate command")
		}
		if command.Effect != "" && command.Effect != "read" && command.Effect != "write" && command.Effect != "unknown" {
			return nil, errors.New("unsupported command effect")
		}
		if err := validateManifestSchema(command.InputSchema); err != nil {
			return nil, err
		}
		commands[command.ID] = true
	}
	if len(commands) > 0 && backend == nil {
		return nil, errors.New("commands require a backend")
	}
	return commands, nil
}

// publicManifestCommands returns the commands a panel or page may invoke: everything
// except the commands reserved by data sources, AI providers and exporters.
func publicManifestCommands(contributes Contributions, declared map[string]bool) map[string]bool {
	reserved := make(map[string]bool)
	for _, source := range contributes.DataSources {
		reserved[source.Command] = true
	}
	for _, provider := range contributes.AIProviders {
		reserved[provider.Command] = true
	}
	for _, exporter := range contributes.Exporters {
		reserved[exporter.Command] = true
	}
	public := make(map[string]bool, len(declared))
	for id := range declared {
		if !reserved[id] {
			public[id] = true
		}
	}
	return public
}

func validateManifestPanels(panels []Panel, commands map[string]bool, permissions map[string]bool) error {
	seen := make(map[string]bool, len(panels))
	nodes := 0
	for _, panel := range panels {
		if !manifestLocalIDPattern.MatchString(panel.ID) || seen[panel.ID] || !validManifestText(panel.Title, 256) {
			return errors.New("invalid or duplicate panel")
		}
		seen[panel.ID] = true
		if panel.HTML != nil {
			if panel.Body.Type != "" {
				return errors.New("panel declares both a declarative body and custom html")
			}
			if !permissions[PageCustomHTMLPermission] {
				return fmt.Errorf("custom html panel requires the %s permission", PageCustomHTMLPermission)
			}
			if err := validateManifestHTML(*panel.HTML, "custom html panel"); err != nil {
				return err
			}
			continue
		}
		if panel.Body.Type == "" {
			return errors.New("panel declares no body")
		}
		if err := validateManifestNode(panel.Body, commands, 0, &nodes); err != nil {
			return err
		}
	}
	return nil
}

// validateManifestHTML accepts bounded UTF-8 text only. Markup is inert data here:
// the host never renders it, so no sanitizer can be bypassed in the host DOM.
func validateManifestHTML(panel PageHTML, label string) error {
	if strings.TrimSpace(panel.Source) == "" {
		return fmt.Errorf("%s is empty", label)
	}
	if len(panel.Source) > maxPageHTMLBytes {
		return fmt.Errorf("%s exceeds size limit", label)
	}
	if !utf8.ValidString(panel.Source) || strings.ContainsRune(panel.Source, 0) {
		return fmt.Errorf("%s is not valid text", label)
	}
	return nil
}

// validateManifestNode keeps installation and rendering in agreement: the renderer
// ignores fields that do not belong to a node type, so a manifest that declares
// them must not be accepted either.
func validateManifestNode(node UINode, commands map[string]bool, depth int, count *int) error {
	*count++
	if depth > maxPageNodeDepth || *count > maxPageNodes {
		return errors.New("panel tree exceeds limit")
	}
	if len(node.Text) > 16384 || len(node.Title) > 1024 || len(node.Arguments) > 64<<10 {
		return errors.New("panel text or arguments exceed limit")
	}
	if len(node.Arguments) > 0 && !json.Valid(node.Arguments) {
		return errors.New("invalid panel arguments")
	}
	switch node.Type {
	case "text", "alert", "column", "row", "button", "table":
	default:
		return errors.New("unsupported panel element")
	}
	if node.Type == "button" && !commands[node.Command] {
		return errors.New("panel button references undeclared command")
	}
	if node.Type != "button" && node.Command != "" {
		return errors.New("non-button command is unsupported")
	}
	switch node.Type {
	case "text", "alert":
		if len(node.Children) > 0 || len(node.Arguments) > 0 || len(node.Columns) > 0 || len(node.Rows) > 0 {
			return errors.New("panel element field is not supported")
		}
	case "column", "row":
		if len(node.Arguments) > 0 || len(node.Columns) > 0 || len(node.Rows) > 0 {
			return errors.New("panel element field is not supported")
		}
	case "button":
		if len(node.Children) > 0 || len(node.Columns) > 0 || len(node.Rows) > 0 {
			return errors.New("panel element field is not supported")
		}
	case "table":
		if len(node.Children) > 0 || len(node.Arguments) > 0 {
			return errors.New("panel element field is not supported")
		}
	}
	if len(node.Columns) > 32 || len(node.Rows) > 500 || len(node.Children) > 128 {
		return errors.New("panel data exceeds limit")
	}
	keys := make(map[string]bool, len(node.Columns))
	for _, column := range node.Columns {
		if !validManifestText(column.Key, 128) || !validManifestText(column.Title, 256) || keys[column.Key] {
			return errors.New("invalid panel column")
		}
		keys[column.Key] = true
	}
	dataBytes := 0
	for _, row := range node.Rows {
		if len(row) > 32 {
			return errors.New("panel row exceeds limit")
		}
		for key, value := range row {
			dataBytes += len(key) + len(value)
			if !keys[key] || !json.Valid(value) {
				return errors.New("invalid panel cell")
			}
		}
	}
	if dataBytes > 256<<10 {
		return errors.New("panel data exceeds byte limit")
	}
	for _, child := range node.Children {
		if err := validateManifestNode(child, commands, depth+1, count); err != nil {
			return err
		}
	}
	return nil
}

func validateManifestBackend(backend *Backend) error {
	if backend == nil {
		return nil
	}
	if backend.Default == nil && len(backend.Platforms) == 0 {
		return errors.New("backend has no entry")
	}
	if len(backend.Platforms) > 16 {
		return errors.New("too many backend platforms")
	}
	if backend.Default != nil {
		if err := validateManifestEntry(*backend.Default); err != nil {
			return err
		}
	}
	for platform, entry := range backend.Platforms {
		if !manifestPlatformPattern.MatchString(platform) {
			return errors.New("unsupported backend platform")
		}
		if err := validateManifestEntry(entry); err != nil {
			return err
		}
	}
	return nil
}

func validateManifestEntry(entry Entry) error {
	if err := SafePackagePath(entry.Executable); err != nil {
		return fmt.Errorf("invalid executable: %w", err)
	}
	switch entry.Runtime {
	case "", "native", "node", "python":
	default:
		return errors.New("unsupported backend runtime")
	}
	if len(entry.Args) > 64 {
		return errors.New("too many executable arguments")
	}
	for _, arg := range entry.Args {
		if len(arg) > 4096 || strings.ContainsRune(arg, 0) {
			return errors.New("invalid executable argument")
		}
	}
	return nil
}

func validateManifestSchema(raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil
	}
	if len(raw) > 64<<10 || !json.Valid(raw) {
		return errors.New("invalid or oversized schema")
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return errors.New("schema must be an object")
	}
	return nil
}

func validateManifestDataSources(m Manifest, commands map[string]bool) error {
	sources := manifestContributions(m).DataSources
	if len(sources) == 0 {
		return nil
	}
	if len(sources) > maxManifestDataSources {
		return errors.New("too many data source contributions")
	}
	if !manifestHasPermission(m, "data.sources") {
		return errors.New("data source contributions require data.sources permission")
	}
	if m.Backend == nil {
		return errors.New("data source contributions require a backend")
	}
	ids := make(map[string]bool, len(sources))
	types := make(map[string]bool, len(sources))
	for _, source := range sources {
		identity := manifestDataSourceIdentity(m.ID, source)
		if identity == "" || ids[source.ID] || types[identity] {
			return errors.New("invalid or duplicate data source identity")
		}
		if !validManifestText(source.Name, 256) {
			return errors.New("invalid data source name")
		}
		if !manifestLocalIDPattern.MatchString(source.Command) || !commands[source.Command] {
			return errors.New("data source references an undeclared command")
		}
		if source.ReadOnly {
			for _, command := range manifestContributions(m).Commands {
				if command.ID == source.Command && command.Effect != "" && command.Effect != "read" && command.Effect != "unknown" {
					return ErrDataSourceWriteEffect
				}
			}
		}
		if source.DefaultPort < 0 || source.DefaultPort > 65535 {
			return errors.New("invalid data source default port")
		}
		ids[source.ID] = true
		types[identity] = true
	}
	return nil
}

func validateManifestSkills(m Manifest) error {
	skills := manifestContributions(m).Skills
	if len(skills) == 0 {
		return nil
	}
	if len(skills) > maxManifestSkills {
		return errors.New("too many skill contributions")
	}
	if !manifestHasPermission(m, "ai.skills") {
		return errors.New("skill contributions require ai.skills permission")
	}
	ids := make(map[string]bool, len(skills))
	for _, skill := range skills {
		if !manifestSkillIDPattern.MatchString(skill.ID) || ids[skill.ID] {
			return errors.New("invalid or duplicate skill id")
		}
		if !validManifestUTF8Text(skill.Name, 256) || !validManifestUTF8Text(skill.Description, 2048) {
			return errors.New("invalid skill metadata")
		}
		if !utf8.ValidString(skill.Entry) || pathBase(skill.Entry) != "SKILL.md" {
			return errors.New("skill entry must name an exact SKILL.md file")
		}
		if err := SafePackagePath(skill.Entry); err != nil {
			return fmt.Errorf("invalid skill entry: %w", err)
		}
		if len(skill.Resources) > maxManifestSkillResources {
			return errors.New("too many skill resources")
		}
		seen := map[string]bool{skill.Entry: true}
		for _, resource := range skill.Resources {
			if seen[resource] || pathExt(resource) != ".md" || pathBase(resource) == "SKILL.md" || SafePackagePath(resource) != nil {
				return errors.New("invalid skill resource")
			}
			seen[resource] = true
		}
		ids[skill.ID] = true
	}
	return nil
}

func validateManifestAIProviders(m Manifest, commands map[string]bool) error {
	providers := manifestContributions(m).AIProviders
	if len(providers) == 0 {
		return nil
	}
	if len(providers) > maxManifestAIProviders {
		return errors.New("too many ai provider contributions")
	}
	if !manifestHasPermission(m, "ai.providers") || m.Backend == nil {
		return errors.New("ai providers require ai.providers permission and a backend")
	}
	ids := make(map[string]bool, len(providers))
	for _, declaration := range providers {
		if manifestAIProviderIdentity(m.ID, declaration) == "" || ids[declaration.ID] {
			return errors.New("invalid or duplicate ai provider identity")
		}
		if !validManifestUTF8Text(declaration.Name, 256) || !commands[declaration.Command] {
			return errors.New("invalid ai provider name or undeclared command")
		}
		if declaration.Icon != "" && !validManifestIcon(declaration.Icon) {
			return errors.New("invalid ai provider icon")
		}
		if declaration.DefaultBaseURL != "" && !validManifestBaseURL(declaration.DefaultBaseURL) {
			return errors.New("invalid ai provider default base url")
		}
		if err := validateManifestAIModels(declaration.Models); err != nil {
			return err
		}
		ids[declaration.ID] = true
	}
	return nil
}

func validateManifestAIModels(models []AIModel) error {
	if len(models) < 1 || len(models) > maxManifestAIModels {
		return errors.New("ai provider must declare one to 32 models")
	}
	ids := make(map[string]bool, len(models))
	for _, model := range models {
		if !manifestAIModelIDPattern.MatchString(model.ID) || ids[model.ID] || !validManifestUTF8Text(model.Name, 256) {
			return errors.New("invalid or duplicate ai model")
		}
		if model.ContextWindow < 1024 || model.ContextWindow > 262144 || model.MaxOutputTokens < 1 ||
			model.MaxOutputTokens > 65536 || model.MaxOutputTokens > model.ContextWindow {
			return errors.New("invalid ai model token limits")
		}
		ids[model.ID] = true
	}
	return nil
}

func validateManifestExporters(m Manifest, commands map[string]bool) error {
	exporters := manifestContributions(m).Exporters
	if len(exporters) == 0 {
		return nil
	}
	if len(exporters) > maxManifestExporters {
		return errors.New("too many exporter contributions")
	}
	if m.Backend == nil || !manifestHasPermission(m, "data.export") {
		return errors.New("exporters require data.export permission and backend")
	}
	ids := make(map[string]bool, len(exporters))
	for _, exporter := range exporters {
		if manifestExporterIdentity(m.ID, exporter) == "" || ids[exporter.ID] {
			return errors.New("invalid or duplicate exporter identity")
		}
		if !utf8.ValidString(exporter.Name) || !validManifestText(exporter.Name, 256) || !commands[exporter.Command] {
			return errors.New("invalid exporter name or undeclared command")
		}
		if !manifestExporterExtensionPattern.MatchString(exporter.Extension) || !manifestExporterContentTypePattern.MatchString(exporter.ContentType) {
			return errors.New("invalid exporter extension or content type")
		}
		ids[exporter.ID] = true
	}
	return nil
}

// SidebarPermission lets a package attach an expandable group to the host's
// left connection tree. It grants no host capability: node data comes from a
// declared command and is rendered as text by the host.
const SidebarPermission = "ui.sidebar"

// maxManifestSidebarGroups bounds groups per manifest.
const maxManifestSidebarGroups = 4

func validateManifestSidebar(m Manifest, permissions, commands map[string]bool) error {
	contributes := manifestContributions(m)
	groups := contributes.Sidebar
	if len(groups) == 0 {
		return nil
	}
	if !permissions[SidebarPermission] {
		return fmt.Errorf("sidebar requires the %s permission", SidebarPermission)
	}
	if len(groups) > maxManifestSidebarGroups {
		return errors.New("too many sidebar groups")
	}
	pages := make(map[string]bool, len(contributes.Pages))
	for _, page := range contributes.Pages {
		pages[page.ID] = true
	}
	seen := make(map[string]bool, len(groups))
	for _, group := range groups {
		if !manifestLocalIDPattern.MatchString(group.ID) || seen[group.ID] || !validManifestText(group.Title, 128) {
			return errors.New("invalid or duplicate sidebar group")
		}
		seen[group.ID] = true
		if !commands[group.ListCommand] {
			return errors.New("sidebar list command is not declared")
		}
		if group.EmptyText != "" && !validManifestText(group.EmptyText, 128) {
			return errors.New("invalid sidebar empty text")
		}
		if group.Icon != "" && !validManifestIcon(group.Icon) {
			return errors.New("invalid sidebar icon")
		}
		if group.Order < minNavigationOrder || group.Order > maxNavigationOrder {
			return errors.New("sidebar order exceeds limit")
		}
		if group.Open == nil {
			continue
		}
		switch group.Open.Type {
		case "window":
			if m.Window == nil {
				return errors.New("window sidebar target requires a window")
			}
			if group.Open.Page != "" {
				return errors.New("window sidebar target cannot declare a page")
			}
		case "page":
			if !permissions[PagesPermission] {
				return fmt.Errorf("page sidebar target requires the %s permission", PagesPermission)
			}
			if !pages[group.Open.Page] {
				return errors.New("sidebar references an undeclared page")
			}
		default:
			return errors.New("unsupported sidebar target")
		}
	}
	return nil
}

func validateManifestConnectionActions(m Manifest, permissions map[string]bool) error {
	actions := manifestContributions(m).ConnectionActions
	if len(actions) > 16 {
		return errors.New("too many connection actions")
	}
	declaredPages := manifestContributions(m).Pages
	pages := make(map[string]bool, len(declaredPages))
	for _, page := range declaredPages {
		pages[page.ID] = true
	}
	seen := make(map[string]bool, len(actions))
	for _, action := range actions {
		if !manifestLocalIDPattern.MatchString(action.ID) || seen[action.ID] ||
			!validManifestText(action.Title, 256) || len(action.Description) > 4096 {
			return errors.New("invalid or duplicate connection action")
		}
		seen[action.ID] = true
		if len(action.ConnectionTypes) == 0 || len(action.ConnectionTypes) > 32 {
			return errors.New("connection action requires connection types")
		}
		types := make(map[string]bool, len(action.ConnectionTypes))
		for _, value := range action.ConnectionTypes {
			if !manifestConnectionTypePattern.MatchString(value) || types[value] {
				return errors.New("invalid or duplicate connection action type")
			}
			types[value] = true
		}
		if len(action.Scopes) > 8 {
			return errors.New("too many connection action scopes")
		}
		scopes := make(map[string]bool, len(action.Scopes))
		for _, scope := range action.Scopes {
			switch scope {
			case "connection", "database", "collection":
			default:
				return errors.New("unsupported connection action scope")
			}
			if scopes[scope] {
				return errors.New("duplicate connection action scope")
			}
			scopes[scope] = true
		}
		switch action.Target.Type {
		case "window":
			if m.Window == nil {
				return errors.New("window connection action requires a window")
			}
			if action.Target.Page != "" {
				return errors.New("window connection action cannot declare a page")
			}
		case "page":
			if !permissions[PagesPermission] {
				return fmt.Errorf("page connection action requires the %s permission", PagesPermission)
			}
			if !pages[action.Target.Page] {
				return errors.New("connection action references an undeclared page")
			}
		default:
			return errors.New("unsupported connection action target")
		}
	}
	return nil
}

// manifestContributions returns the declared block, treating an absent one as
// "declares nothing" so every rule can read fields without a nil check.
func manifestContributions(m Manifest) Contributions {
	if m.Contributes == nil {
		return Contributions{}
	}
	return *m.Contributes
}

func manifestHasPermission(m Manifest, want string) bool {
	for _, permission := range m.Permissions {
		if permission == want {
			return true
		}
	}
	return false
}

func validManifestPluginID(id string) bool {
	if len(id) > 128 || !manifestPluginIDPattern.MatchString(id) {
		return false
	}
	for _, segment := range strings.Split(id, ".") {
		if segment == "" || segment[0] == '-' || segment[len(segment)-1] == '-' {
			return false
		}
	}
	return true
}

func validManifestText(value string, limit int) bool {
	return strings.TrimSpace(value) != "" && len(value) <= limit && !strings.ContainsRune(value, 0)
}

func validManifestUTF8Text(value string, limit int) bool {
	return utf8.ValidString(value) && len(value) <= limit && strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}

// validManifestVersion accepts a bare semver with exactly three numeric parts and
// no leading "v", matching the identity the host records.
//
// The grammar is spelled out here instead of importing golang.org/x/mod/semver:
// this package must build for an external module with GOPROXY=off, and a new
// dependency would break that contract for every plugin author.
func validManifestVersion(value string) bool {
	if len(value) > 128 || strings.HasPrefix(value, "v") {
		return false
	}
	core := strings.SplitN(value, "+", 2)[0]
	core = strings.SplitN(core, "-", 2)[0]
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if !validManifestNumericIdentifier(part) {
			return false
		}
	}
	if rest := value[len(core):]; rest != "" {
		return validManifestVersionSuffix(rest)
	}
	return true
}

// validManifestNumericIdentifier accepts a numeric core part: digits only, and no
// leading zero unless the part is exactly "0" (semver 2.0.0 rule 2).
func validManifestNumericIdentifier(part string) bool {
	if part == "" || (len(part) > 1 && part[0] == '0') {
		return false
	}
	for i := 0; i < len(part); i++ {
		if part[i] < '0' || part[i] > '9' {
			return false
		}
	}
	return true
}

// validManifestVersionSuffix validates "-prerelease" and/or "+build" metadata,
// both of which are dot-separated identifiers of ASCII alphanumerics and hyphens.
func validManifestVersionSuffix(rest string) bool {
	if strings.HasPrefix(rest, "-") {
		body := rest[1:]
		if plus := strings.Index(body, "+"); plus >= 0 {
			if !validManifestDotIdentifiers(body[plus+1:], false) {
				return false
			}
			body = body[:plus]
		}
		return validManifestDotIdentifiers(body, true)
	}
	if strings.HasPrefix(rest, "+") {
		return validManifestDotIdentifiers(rest[1:], false)
	}
	return false
}

func validManifestDotIdentifiers(body string, noLeadingZeroNumeric bool) bool {
	if body == "" {
		return false
	}
	for _, identifier := range strings.Split(body, ".") {
		if identifier == "" {
			return false
		}
		numeric := true
		for i := 0; i < len(identifier); i++ {
			ch := identifier[i]
			isDigit := ch >= '0' && ch <= '9'
			isAlpha := (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
			if !isDigit && !isAlpha && ch != '-' {
				return false
			}
			if !isDigit {
				numeric = false
			}
		}
		if numeric && noLeadingZeroNumeric && len(identifier) > 1 && identifier[0] == '0' {
			return false
		}
	}
	return true
}

func validManifestIcon(value string) bool {
	return len(value) <= 256 && manifestIconPattern.MatchString(value) && SafePackagePath(value) == nil
}

func validManifestBaseURL(raw string) bool {
	if len(raw) > 2048 || strings.TrimSpace(raw) != raw {
		return false
	}
	lower := strings.ToLower(raw)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return false
	}
	rest := raw[strings.Index(raw, "//")+2:]
	if rest == "" {
		return false
	}
	authority := rest
	if idx := strings.IndexAny(authority, "/?#"); idx >= 0 {
		authority = authority[:idx]
	}
	if authority == "" || strings.Contains(authority, "@") {
		return false
	}
	// Fragments and query strings are not endpoint identity.
	tail := rest[len(authority):]
	return !strings.ContainsAny(tail, "#?")
}

// pathBase and pathExt avoid importing path for two calls that only ever see
// slash-separated package-relative names.
func pathBase(name string) string {
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		return name[idx+1:]
	}
	return name
}

func pathExt(name string) string {
	base := pathBase(name)
	if idx := strings.LastIndex(base, "."); idx >= 0 {
		return base[idx:]
	}
	return ""
}

const (
	maxManifestDataSources    = 8
	maxManifestSkills         = 16
	maxManifestSkillResources = 4
	maxManifestAIProviders    = 8
	maxManifestAIModels       = 32
	maxManifestExporters      = 8
)

var (
	manifestPluginIDPattern            = regexp.MustCompile(`^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$`)
	manifestLocalIDPattern             = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)
	manifestPermissionPattern          = regexp.MustCompile(`^[a-z][a-z0-9._:-]{0,127}$`)
	manifestPlatformPattern            = regexp.MustCompile(`^(windows|linux|darwin)/(amd64|arm64|386|arm)$`)
	manifestConnectionTypePattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)
	manifestSkillIDPattern             = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
	manifestAIModelIDPattern           = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$`)
	manifestExporterExtensionPattern   = regexp.MustCompile(`^[a-z0-9]{1,16}$`)
	manifestExporterContentTypePattern = regexp.MustCompile(`^(text|application)/[a-z0-9][a-z0-9.+-]{0,63}$`)
	manifestIconPattern                = regexp.MustCompile(`(?i)\.(png|jpe?g|webp|gif)$`)
	manifestDataSourceIDPattern        = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
	manifestAIProviderIDPattern        = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
	manifestExporterIDPattern          = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
)

// The identity helpers live here rather than being exported: the host keeps its
// own exported forms for runtime routing, and a marketplace only needs the
// equality check below to reject duplicate identities.
// ErrDataSourceWriteEffect means a read-only source points at a command that
// declares effect write. Callers map this sentinel to a user-facing error code.
var ErrDataSourceWriteEffect = errors.New("data source command cannot declare a write effect")

func manifestDataSourceIdentity(pluginID string, source DataSource) string {
	if !validManifestPluginID(pluginID) || !manifestDataSourceIDPattern.MatchString(source.ID) || !validManifestDialect(source.Dialect) {
		return ""
	}
	return "plugin:" + pluginID + ":" + source.ID + ":" + source.Dialect
}

func validManifestDialect(value string) bool {
	return value == "mysql" || value == "postgres" || value == "sqlite"
}

func manifestAIProviderIdentity(pluginID string, declaration AIProvider) string {
	if !validManifestPluginID(pluginID) || !manifestAIProviderIDPattern.MatchString(declaration.ID) {
		return ""
	}
	return "plugin:" + pluginID + ":" + declaration.ID
}

func manifestExporterIdentity(pluginID string, exporter Exporter) string {
	if !validManifestPluginID(pluginID) || !manifestExporterIDPattern.MatchString(exporter.ID) {
		return ""
	}
	return "plugin:" + pluginID + ":" + exporter.ID
}
