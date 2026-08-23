// Command contract-test runs the small, deterministic data-source contract
// matrix used by local development and CI diagnostics.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	reportSchema       = "gonavi.contract-test/v1"
	defaultTestTimeout = 2 * time.Minute
	containerTimeout   = 90 * time.Second
	cleanupTimeout     = 30 * time.Second
)

type csvFlag []string

func (values *csvFlag) String() string {
	return strings.Join(*values, ",")
}

func (values *csvFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

type runOptions struct {
	root              string
	dataSources       []string
	capabilities      []string
	includeContainers bool
	strictContainers  bool
	verbose           bool
	testTimeout       time.Duration
}

type contract struct {
	ID                string
	DataSource        string
	Capabilities      []string
	Fixture           string
	GoTest            *goTestInvocation
	RequiresContainer bool
}

type goTestInvocation struct {
	Package string
	Run     string
	Tags    []string
}

type reportSelection struct {
	DataSources       []string `json:"dataSources"`
	Capabilities      []string `json:"capabilities"`
	IncludeContainers bool     `json:"includeContainers"`
	StrictContainers  bool     `json:"strictContainers"`
}

type reportSummary struct {
	Total   int `json:"total"`
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Skipped int `json:"skipped"`
}

type reportExecution struct {
	Package string   `json:"package"`
	Run     string   `json:"run"`
	Tags    []string `json:"tags"`
}

type contractResult struct {
	ID           string           `json:"id"`
	DataSource   string           `json:"dataSource"`
	Capabilities []string         `json:"capabilities"`
	Fixture      string           `json:"fixture"`
	Status       string           `json:"status"`
	Reason       string           `json:"reason,omitempty"`
	Execution    *reportExecution `json:"execution,omitempty"`
}

type contractReport struct {
	Schema    string           `json:"schema"`
	Selection reportSelection  `json:"selection"`
	Summary   reportSummary    `json:"summary"`
	Results   []contractResult `json:"results"`
	Error     string           `json:"error,omitempty"`
}

type commandResult struct {
	Output string
	Err    error
}

type commandExecutor interface {
	Run(ctx context.Context, directory string, name string, args ...string) commandResult
}

type systemCommandExecutor struct{}

func (systemCommandExecutor) Run(ctx context.Context, directory string, name string, args ...string) commandResult {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	return commandResult{Output: string(output), Err: err}
}

type contractRunner struct {
	executor    commandExecutor
	lookupPath  func(string) (string, error)
	stat        func(string) (os.FileInfo, error)
	stderr      io.Writer
	verbose     bool
	testTimeout time.Duration
}

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdout, os.Stderr))
}

func runCLI(args []string, stdout, stderr io.Writer) int {
	options, err := parseOptions(args, stderr)
	if err != nil {
		return 2
	}

	root, err := findRepositoryRoot(options.root)
	if err != nil {
		report := newReport(options)
		report.Error = "repository root not found"
		_ = writeReport(stdout, report)
		fmt.Fprintf(stderr, "contract-test: %v\n", err)
		return 2
	}

	runner := contractRunner{
		executor:    systemCommandExecutor{},
		lookupPath:  exec.LookPath,
		stat:        os.Stat,
		stderr:      stderr,
		verbose:     options.verbose,
		testTimeout: options.testTimeout,
	}
	report := runner.run(context.Background(), root, options)
	if err := writeReport(stdout, report); err != nil {
		fmt.Fprintf(stderr, "contract-test: write JSON report: %v\n", err)
		return 1
	}
	return reportExitCode(report)
}

func parseOptions(args []string, stderr io.Writer) (runOptions, error) {
	var sources csvFlag
	var capabilities csvFlag
	options := runOptions{
		root:        ".",
		testTimeout: defaultTestTimeout,
	}

	flags := flag.NewFlagSet("contract-test", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&options.root, "root", ".", "repository root or a directory below it")
	flags.Var(&sources, "data-source", "comma-separated data-source names (repeatable)")
	flags.Var(&sources, "datasource", "alias for --data-source")
	flags.Var(&sources, "source", "alias for --data-source")
	flags.Var(&capabilities, "capability", "comma-separated capability names (repeatable)")
	flags.BoolVar(&options.includeContainers, "containers", false, "run optional Docker Compose fixtures")
	flags.BoolVar(&options.includeContainers, "with-containers", false, "alias for --containers")
	flags.BoolVar(&options.strictContainers, "strict-containers", false, "treat unavailable optional containers as failures")
	flags.BoolVar(&options.verbose, "verbose", false, "write failed command output to stderr")
	flags.DurationVar(&options.testTimeout, "test-timeout", defaultTestTimeout, "per-contract Go test timeout")
	if err := flags.Parse(args); err != nil {
		return runOptions{}, err
	}
	if flags.NArg() != 0 {
		return runOptions{}, fmt.Errorf("unexpected positional arguments: %s", strings.Join(flags.Args(), " "))
	}
	if options.testTimeout <= 0 {
		return runOptions{}, errors.New("--test-timeout must be greater than zero")
	}

	options.dataSources = normalizeDataSources(sources)
	options.capabilities = normalizeCapabilities(capabilities)
	return options, nil
}

func findRepositoryRoot(start string) (string, error) {
	current, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(current); err != nil {
		return "", err
	} else if !info.IsDir() {
		current = filepath.Dir(current)
	}

	for {
		if info, err := os.Stat(filepath.Join(current, "go.mod")); err == nil && !info.IsDir() {
			return current, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("could not find go.mod from %s", start)
		}
		current = parent
	}
}

func newReport(options runOptions) contractReport {
	return contractReport{
		Schema: reportSchema,
		Selection: reportSelection{
			DataSources:       append([]string{}, options.dataSources...),
			Capabilities:      append([]string{}, options.capabilities...),
			IncludeContainers: options.includeContainers,
			StrictContainers:  options.strictContainers,
		},
		Results: []contractResult{},
	}
}

func (runner contractRunner) run(ctx context.Context, root string, options runOptions) contractReport {
	report := newReport(options)
	selected := selectContracts(defaultContracts(), options)
	if len(selected) == 0 {
		report.Error = "no contracts matched the supplied filters"
		return report
	}

	for _, item := range selected {
		var result contractResult
		if item.RequiresContainer {
			result = runner.runOptionalRedisFixture(ctx, root, item, options.strictContainers)
		} else {
			result = runner.runGoTest(ctx, root, item)
		}
		report.Results = append(report.Results, result)
	}
	report.Summary = summarizeResults(report.Results)
	return report
}

func selectContracts(matrix []contract, options runOptions) []contract {
	selected := make([]contract, 0, len(matrix))
	for _, item := range matrix {
		if item.RequiresContainer && !options.includeContainers {
			continue
		}
		if !matchesAny([]string{item.DataSource}, options.dataSources) {
			continue
		}
		if !matchesAny(item.Capabilities, options.capabilities) {
			continue
		}
		selected = append(selected, item)
	}
	return selected
}

func matchesAny(values, filter []string) bool {
	if len(filter) == 0 {
		return true
	}
	for _, value := range values {
		for _, candidate := range filter {
			if value == candidate {
				return true
			}
		}
	}
	return false
}

func (runner contractRunner) runGoTest(ctx context.Context, root string, item contract) contractResult {
	result := baseResult(item)
	result.Execution = executionFor(item.GoTest)
	if item.GoTest == nil {
		result.Status = "failed"
		result.Reason = "matrix_configuration_error"
		return result
	}

	args := []string{"test"}
	if len(item.GoTest.Tags) > 0 {
		args = append(args, "-tags", strings.Join(item.GoTest.Tags, ","))
	}
	args = append(args,
		item.GoTest.Package,
		"-run", item.GoTest.Run,
		"-count=1",
		"-timeout="+runner.testTimeout.String(),
	)

	testCtx, cancel := context.WithTimeout(ctx, runner.testTimeout)
	defer cancel()
	command := runner.executor.Run(testCtx, root, "go", args...)
	if command.Err == nil {
		result.Status = "passed"
		return result
	}

	result.Status = "failed"
	if errors.Is(testCtx.Err(), context.DeadlineExceeded) {
		result.Reason = "runner_timeout"
	} else {
		result.Reason = "go_test_failed"
	}
	runner.logFailure(item.ID, "go", args, command.Output)
	return result
}

func (runner contractRunner) runOptionalRedisFixture(ctx context.Context, root string, item contract, strict bool) contractResult {
	fixtureCtx, cancelFixture := context.WithTimeout(ctx, containerTimeout)
	defer cancelFixture()

	if _, err := runner.lookupPath("docker"); err != nil {
		return optionalContainerResult(item, "docker_unavailable", strict)
	}

	version := runner.executor.Run(fixtureCtx, root, "docker", "compose", "version")
	if version.Err != nil {
		runner.logFailure(item.ID, "docker", []string{"compose", "version"}, version.Output)
		return optionalContainerResult(item, "docker_compose_unavailable", strict)
	}
	daemon := runner.executor.Run(fixtureCtx, root, "docker", "info", "--format", "{{.ServerVersion}}")
	if daemon.Err != nil {
		runner.logFailure(item.ID, "docker", []string{"info", "--format", "{{.ServerVersion}}"}, daemon.Output)
		return optionalContainerResult(item, "docker_daemon_unavailable", strict)
	}

	composeFile := filepath.Join(root, "tools", "contract-test", "fixtures", "redis.compose.yml")
	if _, err := runner.stat(composeFile); err != nil {
		return optionalContainerResult(item, "container_fixture_missing", strict)
	}

	projectName := fmt.Sprintf("gonavi-contract-%d", os.Getpid())
	common := []string{"compose", "--project-name", projectName, "--file", composeFile}
	upArgs := append(append([]string{}, common...), "up", "--detach", "--wait", "redis")
	up := runner.executor.Run(fixtureCtx, root, "docker", upArgs...)
	if up.Err != nil {
		runner.logFailure(item.ID, "docker", upArgs, up.Output)
		return optionalContainerResult(item, "container_start_failed", strict)
	}

	probeArgs := append(append([]string{}, common...), "exec", "-T", "redis", "redis-cli", "--raw", "SCAN", "0", "COUNT", "1")
	probe := runner.executor.Run(fixtureCtx, root, "docker", probeArgs...)
	downArgs := append(append([]string{}, common...), "down", "--volumes", "--remove-orphans")
	cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancelCleanup()
	cleanup := runner.executor.Run(cleanupCtx, root, "docker", downArgs...)
	if cleanup.Err != nil {
		runner.logFailure(item.ID, "docker", downArgs, cleanup.Output)
		return optionalContainerResult(item, "container_cleanup_failed", strict)
	}
	if probe.Err != nil {
		runner.logFailure(item.ID, "docker", probeArgs, probe.Output)
		return optionalContainerResult(item, "container_probe_failed", strict)
	}
	if strings.TrimSpace(probe.Output) != "0" {
		return optionalContainerResult(item, "container_cursor_invalid", strict)
	}

	result := baseResult(item)
	result.Status = "passed"
	return result
}

func optionalContainerResult(item contract, reason string, strict bool) contractResult {
	result := baseResult(item)
	result.Reason = reason
	if strict {
		result.Status = "failed"
	} else {
		result.Status = "skipped"
	}
	return result
}

func (runner contractRunner) logFailure(id, command string, args []string, output string) {
	if !runner.verbose || runner.stderr == nil {
		return
	}
	fmt.Fprintf(runner.stderr, "contract %s failed: %s %s\n", id, command, strings.Join(args, " "))
	if output != "" {
		fmt.Fprintln(runner.stderr, strings.TrimSpace(output))
	}
}

func baseResult(item contract) contractResult {
	return contractResult{
		ID:           item.ID,
		DataSource:   item.DataSource,
		Capabilities: append([]string{}, item.Capabilities...),
		Fixture:      item.Fixture,
	}
}

func executionFor(invocation *goTestInvocation) *reportExecution {
	if invocation == nil {
		return nil
	}
	return &reportExecution{
		Package: invocation.Package,
		Run:     invocation.Run,
		Tags:    append([]string{}, invocation.Tags...),
	}
}

func summarizeResults(results []contractResult) reportSummary {
	summary := reportSummary{Total: len(results)}
	for _, result := range results {
		switch result.Status {
		case "passed":
			summary.Passed++
		case "failed":
			summary.Failed++
		case "skipped":
			summary.Skipped++
		}
	}
	return summary
}

func reportExitCode(report contractReport) int {
	if report.Error != "" {
		return 2
	}
	if report.Summary.Failed > 0 {
		return 1
	}
	return 0
}

func writeReport(writer io.Writer, report contractReport) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(report)
}

func defaultContracts() []contract {
	matrix := []contract{
		{
			ID:           "elasticsearch.response-body-limit",
			DataSource:   "elasticsearch",
			Capabilities: []string{"response-body-limit"},
			Fixture:      "httptest",
			GoTest: &goTestInvocation{
				Package: "./internal/db",
				Run:     "^TestLegacyElasticsearchQueryResponseLimits$",
				Tags:    []string{"gonavi_elasticsearch_driver"},
			},
		},
		{
			ID:           "postgres.cancellation",
			DataSource:   "postgres",
			Capabilities: []string{"cancel"},
			Fixture:      "in-process",
			GoTest: &goTestInvocation{
				Package: "./internal/app",
				Run:     "^TestDBQueryMulti_ContextDriverStopsOnParentCancellation$",
				Tags:    []string{},
			},
		},
		{
			ID:           "oceanbase.partial-results",
			DataSource:   "oceanbase",
			Capabilities: []string{"partial-results"},
			Fixture:      "in-process",
			GoTest: &goTestInvocation{
				Package: "./internal/app",
				Run:     "^TestDBGetObjectsMarksExtensionMetadataFailuresPartial$",
				Tags:    []string{},
			},
		},
		{
			ID:           "postgres.permission",
			DataSource:   "postgres",
			Capabilities: []string{"permission"},
			Fixture:      "in-process",
			GoTest: &goTestInvocation{
				Package: "./internal/app",
				Run:     "^TestHeadlessQueryUsesSharedAISafetyAndConnectionProtections$",
				Tags:    []string{},
			},
		},
		{
			ID:           "postgres.timeout",
			DataSource:   "postgres",
			Capabilities: []string{"timeout"},
			Fixture:      "in-process",
			GoTest: &goTestInvocation{
				Package: "./internal/app",
				Run:     "^TestPostgresContractQueryContextUsesExplicitTimeout$",
				Tags:    []string{},
			},
		},
		{
			ID:                "redis.container-cursor",
			DataSource:        "redis",
			Capabilities:      []string{"cursor"},
			Fixture:           "docker-compose",
			RequiresContainer: true,
		},
		{
			ID:           "redis.cursor",
			DataSource:   "redis",
			Capabilities: []string{"cursor"},
			Fixture:      "in-process",
			GoTest: &goTestInvocation{
				Package: "./internal/app",
				Run:     "^(TestParseRedisScanCursor|TestDBGetTablesRedisCursorState)$",
				Tags:    []string{},
			},
		},
		{
			ID:           "sqlite.query-context",
			DataSource:   "sqlite",
			Capabilities: []string{"cancel", "timeout"},
			Fixture:      "sqlite-memory",
			GoTest: &goTestInvocation{
				Package: "./internal/db",
				Run:     "^TestSQLiteContractReadOnlyQueryContextBoundaries$",
				Tags:    []string{"gonavi_sqlite_driver"},
			},
		},
	}
	sort.Slice(matrix, func(left, right int) bool {
		return matrix[left].ID < matrix[right].ID
	})
	return matrix
}

func normalizeDataSources(values []string) []string {
	return normalizeValues(values, func(value string) string {
		switch value {
		case "es":
			return "elasticsearch"
		case "pg", "postgresql":
			return "postgres"
		case "oceanbase-oracle", "oceanbase_oracle":
			return "oceanbase"
		default:
			return value
		}
	})
}

func normalizeCapabilities(values []string) []string {
	return normalizeValues(values, func(value string) string {
		switch value {
		case "cancellation":
			return "cancel"
		case "permissions":
			return "permission"
		case "partial", "partial-result":
			return "partial-results"
		case "body-limit", "response-body", "response-limit":
			return "response-body-limit"
		default:
			return value
		}
	})
}

func normalizeValues(values []string, canonicalize func(string) string) []string {
	unique := make(map[string]struct{})
	for _, value := range values {
		for _, segment := range strings.Split(value, ",") {
			normalized := canonicalize(strings.ToLower(strings.TrimSpace(segment)))
			if normalized != "" {
				unique[normalized] = struct{}{}
			}
		}
	}
	result := make([]string, 0, len(unique))
	for value := range unique {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
