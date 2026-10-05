#!/usr/bin/env python3
"""读取数据源描述表 internal/datasource/specs/*.json，供驱动代理构建与发布脚本使用。

描述表是新数据源的唯一声明处（每个数据源一个文件）；历史驱动仍由各脚本的硬编码清单维护。
脚本通过 `eval "$(python3 tools/datasource-registry.py shell)"` 取得描述表的代理键清单
与按代理键分发的查询函数（只用 case 语句，不依赖关联数组）。

代理键：默认代理等于数据源类型名；独立构建的驱动版本档位用档位 build.key（如 cassandra_legacy）。
代理键不含连字符，保证 "<key>-driver-agent-<os>-<arch>" 资产名可被唯一解析。
"""

from __future__ import annotations

import hashlib
import json
import shlex
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SPECS_RELATIVE = "internal/datasource/specs"
NEWLINE = chr(10)
RELEASE_PLATFORMS = (
    "darwin/amd64",
    "darwin/arm64",
    "windows/amd64",
    "windows/arm64",
    "linux/amd64",
    "linux/arm64",
)


def load_specs(specs_dir: Path | None = None) -> list[dict]:
    directory = specs_dir or REPO_ROOT / SPECS_RELATIVE
    specs = []
    for path in sorted(directory.glob("*.json")):
        spec = json.loads(path.read_text(encoding="utf-8"))
        if spec.get("type") != path.stem:
            raise SystemExit(f"{path.name} declares type {spec.get('type')!r}, want {path.stem!r}")
        specs.append(spec)
    return specs


def load_specs_at_commit(commit: str) -> list[dict]:
    """读取某个提交里的描述表；提交里没有描述表目录时返回空列表。"""
    listing = subprocess.run(
        ["git", "ls-tree", "--name-only", f"{commit}:{SPECS_RELATIVE}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if listing.returncode != 0:
        return []
    specs = []
    for name in sorted(listing.stdout.split()):
        if not name.endswith(".json"):
            continue
        shown = subprocess.run(
            ["git", "show", f"{commit}:{SPECS_RELATIVE}/{name}"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        specs.append(json.loads(shown.stdout))
    return specs


def default_agent(spec: dict) -> dict:
    agent = dict(spec["agent"])
    agent["key"] = spec["type"]
    return agent


def agent_units(spec: dict) -> list[tuple[str, dict]]:
    """返回 (代理键, 构建声明)：默认代理在前，独立构建档位随后。"""
    units = [(spec["type"], default_agent(spec))]
    for item in spec.get("variants", {}).get("items", []):
        build = item.get("build")
        if build:
            units.append((build["key"], build))
    return units


def unit_entry_hash(spec: dict, unit: str) -> str:
    """单元指纹：该数据源描述（含全部档位）的规范化 JSON 哈希，加上代理键。

    描述表通过 go:embed 进入代理，修订号脚本只哈希 Go 源码，所以要把描述本身纳入指纹；
    只用本条描述，其他数据源的改动不会要求重装本驱动。ui 段只给连接表单用、代理不读取，
    不计入指纹，调整表单声明不会让用户重装驱动。
    """
    agent_relevant = {key: value for key, value in spec.items() if key != "ui"}
    canonical = json.dumps(agent_relevant, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload = unit + "|" + canonical
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def unit_go_modules(spec: dict, unit: str, build: dict) -> list[str]:
    modules = [build.get("goModule", "")]
    if unit == spec["type"]:
        modules.extend(spec.get("moduleAliases", []))
    return [module for module in modules if module]


def unit_text_tokens(spec: dict, unit: str, build: dict) -> list[str]:
    """变更归因用的文本片段：provider 文件名、实现文件前缀、构建标签、Go module 与较长的类型名/别名。

    只用至少 5 个字符的类型名/别名做子串匹配，避免 hive、etcd、d1 这类短名误伤无关路径。
    """
    tokens = {f"provider_{unit}.go", f"internal/db/{spec['type']}_", build["buildTag"]}
    for name in [spec["type"], *spec.get("aliases", [])]:
        if len(name) >= 5:
            tokens.add(name.lower())
    tokens.update(module.lower() for module in unit_go_modules(spec, unit, build))
    return sorted(tokens)


def changed_units(base: list[dict], head: list[dict]) -> list[str]:
    def hashes(specs: list[dict]) -> dict[str, str]:
        return {unit: unit_entry_hash(spec, unit) for spec in specs for unit, _ in agent_units(spec)}

    before, after = hashes(base), hashes(head)
    return sorted(unit for unit in set(before) | set(after) if before.get(unit) != after.get(unit))


def case_arm(patterns: list[str], body: str) -> str:
    joined = "|".join(shlex.quote(pattern) for pattern in patterns)
    return f"    {joined}) {body} ;;"


def render_function(name: str, arms: list[str], default: str) -> str:
    lines = [f"{name}() {{", '  case "${1:-}" in', *arms, f"    *) {default} ;;", "  esac", "}"]
    return NEWLINE.join(lines)


def render_shell(specs: list[dict]) -> str:
    units = [(spec, unit, build) for spec in specs for unit, build in agent_units(spec)]

    normalize_arms = []
    for spec in specs:
        names = [spec["type"], *spec.get("aliases", [])]
        normalize_arms.append(case_arm([name.lower() for name in names], f"echo {shlex.quote(spec['type'])}"))
    for spec, unit, _ in units:
        if unit != spec["type"]:
            normalize_arms.append(case_arm([unit], f"echo {shlex.quote(unit)}"))

    tag_arms = [case_arm([unit], f"echo {shlex.quote(build['buildTag'])}") for _, unit, build in units]
    cgo_arms = [case_arm([unit], "echo 1") for _, unit, build in units if build.get("cgo")]
    hash_arms = [case_arm([unit], f"echo {unit_entry_hash(spec, unit)}") for spec, unit, _ in units]
    prefix_arms = []
    module_arms = []
    platform_arms = []
    for spec, unit, build in units:
        prefixes = build.get("sourcePrefixes") or spec["agent"].get("sourcePrefixes") or [spec["type"]]
        prefix_arms.append(case_arm([unit], f"echo {shlex.quote(' '.join(prefixes))}"))
        modules = unit_go_modules(spec, unit, build)
        if modules:
            quoted = " ".join(shlex.quote(module) for module in modules)
            module_arms.append(case_arm([unit], f"printf '%s\\n' {quoted}"))
        platforms = build.get("platforms") or spec["agent"].get("platforms") or []
        if platforms:
            allowed = " ".join(platforms)
            platform_arms.append(case_arm([unit], f'[[ " {allowed} " == *" ${{2:-}} "* ]]'))

    token_lines = ["registry_emit_driver_tokens() {"]
    for spec, unit, build in units:
        patterns = "|".join(f"*{shlex.quote(token)}*" for token in unit_text_tokens(spec, unit, build))
        token_lines.append(f'  case "${{1:-}}" in {patterns}) emit_driver_token {shlex.quote(unit)} ;; esac')
    token_lines.extend(["  return 0", "}"])

    parts = [
        "REGISTRY_DRIVERS=(" + " ".join(shlex.quote(unit) for _, unit, _ in units) + ")",
        render_function("registry_normalize_driver", normalize_arms, "return 1"),
        render_function("registry_driver_build_tag", tag_arms, "return 1"),
        render_function("registry_driver_cgo", cgo_arms, "echo 0"),
        render_function("registry_driver_entry_hash", hash_arms, "return 1"),
        render_function("registry_driver_source_prefixes", prefix_arms, "return 1"),
        render_function("registry_driver_go_modules", module_arms, "return 0"),
        render_function("registry_driver_platform_supported", platform_arms, "return 0"),
        NEWLINE.join(token_lines),
    ]
    return NEWLINE.join(parts) + NEWLINE


def render_json(specs: list[dict]) -> str:
    units = []
    for spec in specs:
        for unit, build in agent_units(spec):
            units.append({
                "driver": unit,
                "type": spec["type"],
                "aliases": spec.get("aliases", []) if unit == spec["type"] else [],
                "buildTag": build["buildTag"],
                "cgo": bool(build.get("cgo")),
                "platforms": build.get("platforms") or spec["agent"].get("platforms") or list(RELEASE_PLATFORMS),
                "goModules": unit_go_modules(spec, unit, build),
            })
    return json.dumps(units, ensure_ascii=False, indent=2) + NEWLINE


USAGE = "usage: datasource-registry.py shell | drivers | json | changed-units <base-commit> <head-commit>"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(USAGE, file=sys.stderr)
        return 2
    command = argv[1]
    if command == "changed-units":
        if len(argv) != 4:
            print(USAGE, file=sys.stderr)
            return 2
        for unit in changed_units(load_specs_at_commit(argv[2]), load_specs_at_commit(argv[3])):
            print(unit)
        return 0
    specs = load_specs()
    if command == "shell":
        sys.stdout.write(render_shell(specs))
    elif command == "drivers":
        for spec in specs:
            for unit, _ in agent_units(spec):
                print(unit)
    elif command == "json":
        sys.stdout.write(render_json(specs))
    else:
        print(USAGE, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
