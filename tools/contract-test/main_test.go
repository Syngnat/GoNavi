package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type commandCall struct {
	directory string
	name      string
	args      []string
}

type recordingExecutor struct {
	calls   []commandCall
	results []commandResult
}

func (executor *recordingExecutor) Run(_ context.Context, directory string, name string, args ...string) commandResult {
	executor.calls = append(executor.calls, commandCall{
		directory: directory,
		name:      name,
		args:      append([]string{}, args...),
	})
	if len(executor.results) == 0 {
		return commandResult{}
	}
	result := executor.results[0]
	executor.results = executor.results[1:]
	return result
}

func TestNormalizeSelectorsCanonicalizesAndSorts(t *testing.T) {
	if got := normalizeDataSources([]string{" SQLite,PG ", "postgresql", "es"}); strings.Join(got, ",") != "elasticsearch,postgres,sqlite" {
		t.Fatalf("normalized data sources = %v", got)
	}
	if got := normalizeCapabilities([]string{"cancellation, body-limit", "partial", "permissions"}); strings.Join(got, ",") != "cancel,partial-results,permission,response-body-limit" {
		t.Fatalf("normalized capabilities = %v", got)
	}
}

func TestSelectContractsUsesAnyRequestedDataSourceOrCapability(t *testing.T) {
	selected := selectContracts(defaultContracts(), runOptions{
		dataSources:  []string{"redis", "sqlite"},
		capabilities: []string{"cancel", "cursor"},
	})
	ids := make([]string, 0, len(selected))
	for _, item := range selected {
		ids = append(ids, item.ID)
	}
	if got, want := strings.Join(ids, ","), "redis.cursor,sqlite.query-context"; got != want {
		t.Fatalf("selected IDs = %q, want %q", got, want)
	}
}

func TestRunGoTestPreservesTaggedInvocationAndBoundsTimeout(t *testing.T) {
	executor := &recordingExecutor{}
	runner := contractRunner{
		executor:    executor,
		testTimeout: 3 * time.Second,
	}
	item := contract{
		ID:           "sqlite.query-context",
		DataSource:   "sqlite",
		Capabilities: []string{"cancel"},
		Fixture:      "sqlite-memory",
		GoTest: &goTestInvocation{
			Package: "./internal/db",
			Run:     "^TestSQLiteContract$",
			Tags:    []string{"gonavi_sqlite_driver"},
		},
	}

	result := runner.runGoTest(context.Background(), "C:/repo", item)
	if result.Status != "passed" {
		t.Fatalf("result = %#v", result)
	}
	if len(executor.calls) != 1 {
		t.Fatalf("call count = %d, want 1", len(executor.calls))
	}
	call := executor.calls[0]
	if call.directory != "C:/repo" || call.name != "go" {
		t.Fatalf("unexpected command call: %#v", call)
	}
	if got, want := strings.Join(call.args, " "), "test -tags gonavi_sqlite_driver ./internal/db -run ^TestSQLiteContract$ -count=1 -timeout=3s"; got != want {
		t.Fatalf("arguments = %q, want %q", got, want)
	}
}

func TestOptionalContainerUnavailableIsReportedAsClearSkip(t *testing.T) {
	runner := contractRunner{
		lookupPath: func(string) (string, error) {
			return "", errors.New("not found")
		},
	}
	item := contract{
		ID:           "redis.container-cursor",
		DataSource:   "redis",
		Capabilities: []string{"cursor"},
		Fixture:      "docker-compose",
	}

	result := runner.runOptionalRedisFixture(context.Background(), ".", item, false)
	if result.Status != "skipped" || result.Reason != "docker_unavailable" {
		t.Fatalf("optional result = %#v", result)
	}
	strictResult := runner.runOptionalRedisFixture(context.Background(), ".", item, true)
	if strictResult.Status != "failed" || strictResult.Reason != "docker_unavailable" {
		t.Fatalf("strict optional result = %#v", strictResult)
	}
}

func TestOptionalContainerReportsDaemonUnavailableBeforeStartingFixtures(t *testing.T) {
	executor := &recordingExecutor{
		results: []commandResult{
			{},
			{Err: errors.New("daemon is stopped")},
		},
	}
	runner := contractRunner{
		executor: executor,
		lookupPath: func(string) (string, error) {
			return "docker", nil
		},
	}
	item := contract{
		ID:           "redis.container-cursor",
		DataSource:   "redis",
		Capabilities: []string{"cursor"},
		Fixture:      "docker-compose",
	}

	result := runner.runOptionalRedisFixture(context.Background(), ".", item, false)
	if result.Status != "skipped" || result.Reason != "docker_daemon_unavailable" {
		t.Fatalf("daemon-unavailable result = %#v", result)
	}
	if len(executor.calls) != 2 || strings.Join(executor.calls[1].args, " ") != "info --format {{.ServerVersion}}" {
		t.Fatalf("unexpected docker probes: %#v", executor.calls)
	}
}

func TestOptionalContainerRunsReadOnlyCursorProbeAndCleansUp(t *testing.T) {
	executor := &recordingExecutor{
		results: []commandResult{
			{},
			{},
			{},
			{Output: "0\n\n"},
			{},
		},
	}
	runner := contractRunner{
		executor: executor,
		lookupPath: func(string) (string, error) {
			return "docker", nil
		},
		stat: func(string) (os.FileInfo, error) {
			return nil, nil
		},
	}
	item := contract{
		ID:           "redis.container-cursor",
		DataSource:   "redis",
		Capabilities: []string{"cursor"},
		Fixture:      "docker-compose",
	}

	result := runner.runOptionalRedisFixture(context.Background(), ".", item, false)
	if result.Status != "passed" {
		t.Fatalf("container result = %#v", result)
	}
	if len(executor.calls) != 5 {
		t.Fatalf("command count = %d, want 5: %#v", len(executor.calls), executor.calls)
	}
	if got := strings.Join(executor.calls[3].args, " "); !strings.Contains(got, "exec -T redis redis-cli --raw SCAN 0 COUNT 1") {
		t.Fatalf("cursor probe command = %q", got)
	}
	if got := strings.Join(executor.calls[4].args, " "); !strings.Contains(got, "down --volumes --remove-orphans") {
		t.Fatalf("cleanup command = %q", got)
	}
}

func TestNoMatchingContractsProducesAStableConfigurationError(t *testing.T) {
	runner := contractRunner{}
	report := runner.run(context.Background(), ".", runOptions{
		dataSources: []string{"unknown"},
	})
	if report.Error != "no contracts matched the supplied filters" {
		t.Fatalf("report error = %q", report.Error)
	}
	if reportExitCode(report) != 2 {
		t.Fatalf("exit code = %d, want 2", reportExitCode(report))
	}
}

func TestWriteReportIsStableJSON(t *testing.T) {
	report := contractReport{
		Schema: reportSchema,
		Selection: reportSelection{
			DataSources:  []string{"sqlite"},
			Capabilities: []string{"cancel"},
		},
		Summary: reportSummary{Total: 1, Passed: 1},
		Results: []contractResult{{
			ID:           "sqlite.query-context",
			DataSource:   "sqlite",
			Capabilities: []string{"cancel", "timeout"},
			Fixture:      "sqlite-memory",
			Status:       "passed",
			Execution: &reportExecution{
				Package: "./internal/db",
				Run:     "^TestSQLiteContractReadOnlyQueryContextBoundaries$",
				Tags:    []string{"gonavi_sqlite_driver"},
			},
		}},
	}

	var first bytes.Buffer
	var second bytes.Buffer
	if err := writeReport(&first, report); err != nil {
		t.Fatalf("first report: %v", err)
	}
	if err := writeReport(&second, report); err != nil {
		t.Fatalf("second report: %v", err)
	}
	if first.String() != second.String() {
		t.Fatalf("JSON report is not stable:\nfirst:\n%s\nsecond:\n%s", first.String(), second.String())
	}
	if strings.Contains(first.String(), "duration") {
		t.Fatalf("report must not contain volatile execution duration: %s", first.String())
	}
	if !strings.Contains(first.String(), "\"schema\": \"gonavi.contract-test/v1\"") {
		t.Fatalf("report schema missing: %s", first.String())
	}
}

func TestParseOptionsAcceptsAliases(t *testing.T) {
	options, err := parseOptions([]string{
		"--datasource", "SQLite,PG",
		"--source", "redis",
		"--capability", "cancellation,body-limit",
		"--with-containers",
		"--test-timeout", "5s",
	}, os.Stderr)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(options.dataSources, ","), "postgres,redis,sqlite"; got != want {
		t.Fatalf("data sources = %q, want %q", got, want)
	}
	if got, want := strings.Join(options.capabilities, ","), "cancel,response-body-limit"; got != want {
		t.Fatalf("capabilities = %q, want %q", got, want)
	}
	if !options.includeContainers || options.testTimeout != 5*time.Second {
		t.Fatalf("options = %#v", options)
	}
}
