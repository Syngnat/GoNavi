#!/usr/bin/env python3
"""Keep Linux Wails test builds on the WebKit ABI installed by CI."""
from pathlib import Path
import re
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]


def missing_webkit_tag(workflow: str) -> list[str]:
    match = re.search(r"(?ms)^  full:\n(.*?)(?=^  [\w-]+:|\Z)", workflow)
    if match is None:
        raise ValueError("missing full Linux test job")
    violations = []
    for command in re.findall(r"(?m)^\s+run: (go test .+)$", match.group(1)):
        arguments = shlex.split(command)
        if not any(arg in ("./...", ".", "./internal/app", "./internal/app/") for arg in arguments):
            continue
        tags = []
        for index, argument in enumerate(arguments):
            if argument == "-tags" and index + 1 < len(arguments):
                tags.extend(arguments[index + 1].replace(",", " ").split())
            elif argument.startswith("-tags="):
                tags.extend(argument[6:].replace(",", " ").split())
        if "webkit2_41" not in tags:
            violations.append(command)
    return violations


class BackendWorkflowTest(unittest.TestCase):
    def test_clean_frontend_build_job_is_configured(self):
        workflow = (ROOT / ".github/workflows/backend-tests.yml").read_text(encoding="utf-8")
        frontend = re.search(r"(?ms)^  frontend:\n(.*?)(?=^  [\w-]+:|\Z)", workflow)
        self.assertIsNotNone(frontend, "missing clean frontend job")
        block = frontend.group(1)
        self.assertIn("node-version: '20'", block)
        self.assertIn("working-directory: frontend", block)
        self.assertIn("run: npm ci --no-audit --no-fund", block)
        self.assertIn("run: npm run build", block)
        self.assertIn("working-directory: sdk/typescript", block)
        self.assertIn("node ../../frontend/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json", block)
        self.assertIn("--lib ES2022,DOM test/manifest-types.ts", block)
        self.assertIn("node ../../frontend/node_modules/vitest/vitest.mjs run --config vitest.config.mjs", block)
        self.assertIn("npm test -- src/plugins --maxWorkers=2 --minWorkers=1", block)
        self.assertIn("npm test -- src/i18n/keyResolution.test.ts --maxWorkers=1 --minWorkers=1", block)

    def test_marketplace_contract_and_plugin_races_are_configured(self):
        workflow = (ROOT / ".github/workflows/backend-tests.yml").read_text(encoding="utf-8")
        block = re.search(r"(?ms)^  marketplace-contract:\n(.*?)(?=^  [\w-]+:|\Z)", workflow)
        self.assertIsNotNone(block)
        self.assertIn("go test -race ./internal/plugin ./internal/pluginmarket -count=1 -timeout=10m", block.group(1))
        self.assertNotIn("./internal/market", block.group(1))
        self.assertNotIn("postgres:", block.group(1))
        self.assertIn("go test -race ./internal/db -run '^TestPluginDatabase'", block.group(1))
        self.assertIn("go test -race ./internal/ai/provider -run '^TestPlugin'", block.group(1))
        self.assertIn("go test -race ./internal/dataexport -run '^TestPlugin'", block.group(1))
        self.assertIn("go test ./internal/db ./internal/app ./internal/mcpserver ./internal/ai/provider ./internal/ai/service ./internal/dataexport -run '^TestPlugin'", workflow)

    def test_app_and_root_builds_select_installed_webkit(self):
        workflow = (ROOT / ".github/workflows/backend-tests.yml").read_text(encoding="utf-8")
        self.assertEqual(missing_webkit_tag(workflow), [], "Linux app/root tests must select webkit2_41")

    def test_hive_protocol_suite_is_portable_and_not_hidden_by_lite_build(self):
        workflow = (ROOT / ".github/workflows/backend-tests.yml").read_text(encoding="utf-8")
        self.assertIn("go test -tags gonavi_hive_driver ./internal/db/ ./internal/hivesql/ ./cmd/optional-driver-agent/ -count=1", workflow)
        self.assertIn("go test -tags gonavi_hive_driver ./internal/db/ ./internal/hivesql/ ./cmd/optional-driver-agent/ -run Hive", workflow)
        self.assertIn("run: npm test -- src/utils/hive", workflow)

    def test_detects_driver_command_even_with_narrow_test_filter(self):
        workflow = "  full:\n    run: go test -tags gonavi_duckdb_driver ./internal/app/ -run DuckDB\n"
        self.assertEqual(len(missing_webkit_tag(workflow)), 1)
        self.assertEqual(missing_webkit_tag(workflow.replace("gonavi_duckdb_driver", "webkit2_41,gonavi_duckdb_driver")), [])

    def test_other_platform_jobs_are_outside_linux_policy(self):
        workflow = "  full:\n    run: go test -tags=webkit2_41 ./...\n  platform-sensitive:\n    run: go test ./internal/app/\n"
        self.assertEqual(missing_webkit_tag(workflow), [])


if __name__ == "__main__":
    unittest.main()
