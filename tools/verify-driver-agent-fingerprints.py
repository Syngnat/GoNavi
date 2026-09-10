#!/usr/bin/env python3
"""校验 driver-agent 指纹与 canonical revision map 一致（发布闸门）。

背景：driver-agent 是独立进程，客户端按 internal/db/driver_agent_revisions_gen.go
里记录的指纹拒绝不匹配的 agent。曾经发生过发布资产里的 agent 指纹落后于
revision map（客户端全部预编译源被拒、被迫回退 8 分钟本地构建）的事故。
本工具在发布流水线里把这类脱节挡在发布之前。

两种模式：

  binaries   静态扫描待发布的 agent 可执行文件，提取内嵌的
             src-<16hex> 指纹，要求与 canonical revision map 一致。
  published  对已发布的 GoNavi-DriverAgents-Manifest.json 做同样比对，
             用于"本次构建不重发驱动资产（has_changes=false）"的场景：
             已发布资产的 revision 必须仍然等于最新 revision map。

用法：
  python3 tools/verify-driver-agent-fingerprints.py binaries \
      --drivers-dir release-assets/drivers \
      --revision-map windows/amd64=map/windows-amd64/driver_agent_revisions_gen.go \
      --revision-map linux/amd64=map/linux-amd64/driver_agent_revisions_gen.go
  python3 tools/verify-driver-agent-fingerprints.py published \
      --manifest GoNavi-DriverAgents-Manifest.json \
      --revision-map windows/amd64=map/windows-amd64/driver_agent_revisions_gen.go

mongodb v1 变体（mongodb-driver-agent-v1-*）不在 revision map 覆盖范围内
（客户端对 v1 跳过校验），只要求其内嵌了指纹；其余 agent 必须逐个等于 map 值。
"""

import argparse
import json
import re
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REVISION_RE = re.compile(rb"src-[0-9a-f]{16}")
AGENT_FILENAME_RE = re.compile(
    r"^(?P<driver>[a-z0-9_]+?)-driver-agent(?:-(?P<variant>v[0-9]+))?"
    r"-(?P<goos>darwin|linux|windows)-(?P<goarch>amd64|arm64)(?:\.exe)?$"
)
GEN_MAP_ENTRY_RE = re.compile(r'"([A-Za-z0-9_]+)":\s*"(src-[0-9a-f]{16})"')

# `diros` 是历史拼写；指纹校验器对外统一使用 Doris 的规范键 `doris`。
# 已发布资产和旧 revision map 中仍可能出现 `diros`，读取时兼容归一。
DRIVER_ALIASES = {
    "diros": "doris",
    "open_gauss": "opengauss",
    "open-gauss": "opengauss",
    "gauss_db": "gaussdb",
    "gauss-db": "gaussdb",
    "elastic": "elasticsearch",
}


def normalize_driver(name):
    name = (name or "").strip().lower()
    return DRIVER_ALIASES.get(name, name)


def is_driver_supported_on_platform(driver, platform):
    """Return whether the platform is expected to ship this driver agent."""
    return not (driver == "duckdb" and platform == "windows/arm64")


def parse_revision_maps(pairs):
    maps = {}
    for item in pairs:
        if "=" not in item:
            raise SystemExit(f"invalid --revision-map (expected <goos/goarch>=<path>): {item}")
        platform, _, path = item.partition("=")
        platform = platform.strip()
        if platform not in maps and "/" not in platform:
            raise SystemExit(f"invalid platform in --revision-map: {item}")
        text = Path(path).read_text(encoding="utf-8")
        entries = {}
        for driver, revision in GEN_MAP_ENTRY_RE.findall(text):
            canonical_driver = normalize_driver(driver)
            previous_revision = entries.get(canonical_driver)
            if previous_revision and previous_revision != revision:
                raise SystemExit(
                    f"revision map has conflicting aliases for {canonical_driver}: {path}"
                )
            entries[canonical_driver] = revision
        if not entries:
            raise SystemExit(f"revision map has no entries: {path}")
        maps[platform] = entries
    if not maps:
        raise SystemExit("at least one --revision-map is required")
    return maps


def collect_release_agent_files(assets_dir):
    """遍历发布产物目录：展开 *.zip 里的 agent 成员，并收录散装 agent 文件。"""
    files = []
    for path in sorted(Path(assets_dir).rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() == ".zip":
            with zipfile.ZipFile(path) as archive:
                for member in archive.infolist():
                    match = AGENT_FILENAME_RE.match(Path(member.filename).name)
                    if match:
                        groups = match.groupdict()
                        groups["_name"] = Path(member.filename).name
                        files.append((f"{path.name}!{member.filename}", groups, archive.read(member)))
            continue
        match = AGENT_FILENAME_RE.match(path.name)
        if match:
            groups = match.groupdict()
            groups["_name"] = path.name
            files.append((str(path), groups, path.read_bytes()))
    return files


def probe_agent_payload(payload: bytes, timeout_seconds: int = 30, suffix: str = "") -> str:
    """运行 agent 二进制并通过 stdio metadata 协议取回自报指纹。

    与 tools/compress-driver-artifact.sh 的冒烟测试同协议：
    stdin 发 {"id":1,"method":"metadata"}，首行 JSON 的 data.agentRevision 即指纹。
    linux 产物经过 UPX 加壳，静态扫描不可行，只能这样运行时探测。
    suffix 用于 Windows 上运行 PE 时补 .exe 扩展名。
    """
    with tempfile.TemporaryDirectory(prefix="gonavi-agent-probe-") as tmp:
        exe = Path(tmp) / ("agent" + suffix)
        exe.write_bytes(payload)
        exe.chmod(0o755)
        try:
            proc = subprocess.run(
                [str(exe)],
                input=b'{"id":1,"method":"metadata"}\n',
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("metadata 探测超时") from exc
        if proc.returncode != 0 and not proc.stdout:
            raise RuntimeError(
                f"agent 退出码 {proc.returncode}: {proc.stderr.decode('utf-8', 'replace')[:200]}"
            )
        for line in proc.stdout.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if not line:
                continue
            payload_json = json.loads(line)
            if not payload_json.get("success"):
                raise RuntimeError(f"metadata 调用失败: {str(payload_json.get('error'))[:200]}")
            data = payload_json.get("data") or {}
            revision = str(data.get("agentRevision") or "").strip()
            if not revision:
                raise RuntimeError("metadata 响应缺少 agentRevision")
            return revision
        raise RuntimeError("metadata 响应为空")


def verify_binaries(assets_dir, revision_maps, dynamic_probe_platforms=(), skip_platforms=(), prober=None):
    prober = prober or probe_agent_payload
    dynamic_probe_platforms = set(dynamic_probe_platforms)
    skip_platforms = set(skip_platforms)
    failures = []
    skipped = []
    checked = 0
    platform_files = {}
    for label, groups, payload in collect_release_agent_files(assets_dir):
        platform = f"{groups['goos']}/{groups['goarch']}"
        platform_files.setdefault(platform, []).append((label, groups, payload))

    for platform in sorted(skip_platforms):
        if platform in platform_files:
            skipped.append(f"{platform}: 共 {len(platform_files[platform])} 个 agent 跳过校验")

    for platform, revision_map in sorted(revision_maps.items()):
        entries = platform_files.get(platform, [])
        if not entries:
            failures.append(f"{platform}: revision map 存在但发布产物里没有该平台的 agent 文件")
            continue
        if platform in skip_platforms:
            continue
        for label, groups, payload in entries:
            driver = normalize_driver(groups["driver"])
            variant = groups["variant"]
            expected = revision_map.get(driver)
            label = f"{platform} {label}"
            if driver not in revision_map:
                failures.append(f"{label}: revision map 中没有驱动 {driver} 的条目")
                continue
            if variant == "v1":
                # mongodb v1 变体不在 map 覆盖范围（客户端跳过 v1 校验），只要求已内嵌指纹
                checked += 1
                continue
            if not expected:
                checked += 1
                continue
            if platform in dynamic_probe_platforms:
                try:
                    actual = prober(payload)
                except Exception as exc:  # noqa: BLE001 - 探测失败必须显式暴露
                    failures.append(f"{label}: 运行时探测失败: {exc}")
                    continue
                checked += 1
                if actual != expected:
                    failures.append(
                        f"{label}: 指纹不一致（发布资产={actual}，canonical map 要求={expected}）"
                    )
            else:
                # agent 内嵌整张 revision map（运行时查自己那项），静态校验的语义是：
                # 内嵌指纹集合必须包含本驱动的 canonical 指纹。
                found = sorted({match.decode("ascii") for match in REVISION_RE.findall(payload)})
                if not found:
                    failures.append(
                        f"{label}: 未内嵌任何 revision 指纹（若该平台产物经 UPX 等加壳，"
                        "应改用 --dynamic-probe 运行时探测）"
                    )
                    continue
                checked += 1
                if expected not in found:
                    preview = ", ".join(found[:3]) + (f" 等 {len(found)} 个" if len(found) > 3 else "")
                    failures.append(
                        f"{label}: 发布资产未内嵌 canonical 指纹"
                        f"（期望 {expected}；实际内嵌 {preview}）"
                    )

    for platform in sorted(set(platform_files) - set(revision_maps)):
        failures.append(f"{platform}: 发布产物里有该平台的 agent，但未提供对应的 --revision-map")

    return checked, failures, skipped


def verify_published(manifest_path, revision_maps):
    failures = []
    checked = 0
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    assets = manifest.get("assets") or {}
    grouped = {}
    for name, asset in assets.items():
        if not isinstance(asset, dict):
            continue
        platform = str(asset.get("platform") or "")
        driver = normalize_driver(str(asset.get("driverType") or asset.get("driver") or ""))
        revision = str(asset.get("revision") or "")
        if platform and driver:
            grouped.setdefault((platform, driver), {"revisions": set(), "names": []})
            grouped[(platform, driver)]["revisions"].add(revision)
            grouped[(platform, driver)]["names"].append(name)

    for platform, revision_map in sorted(revision_maps.items()):
        for driver, expected in sorted(revision_map.items()):
            if not is_driver_supported_on_platform(driver, platform):
                continue
            if not expected:
                continue
            group = grouped.get((platform, driver))
            if group is None:
                failures.append(
                    f"{platform} {driver}: 已发布清单缺少该驱动资产（期望指纹 {expected}）"
                )
                continue
            checked += 1
            if expected not in group["revisions"]:
                actual = ",".join(sorted(rev or "<empty>" for rev in group["revisions"]))
                failures.append(
                    f"{platform} {driver}: 已发布资产指纹不一致"
                    f"（发布={actual}，canonical map 要求={expected}）"
                )

    for (platform, driver), _group in sorted(grouped.items()):
        if platform in revision_maps and driver not in revision_maps[platform]:
            print(
                f"warning: 已发布清单包含 revision map 未覆盖的驱动（跳过比对）: "
                f"{platform} {driver}",
                file=sys.stderr,
            )

    return checked, failures


def report(mode, checked, failures, skipped=None):
    summary = f"{mode}: 比对 {checked} 个 agent 指纹"
    if skipped:
        summary += f"，跳过 {len(skipped)} 项"
    if failures:
        summary += f"，{len(failures)} 个不一致"
    print(summary)
    for skip in skipped or []:
        print(f"  SKIP {skip}")
    for failure in failures:
        print(f"  MISMATCH {failure}")
    if failures:
        print(
            "driver-agent 指纹与 canonical revision map 不一致：请重新发布驱动资产，"
            "否则客户端会拒绝预编译包并回退本地构建。",
            file=sys.stderr,
        )
        return 1
    print("driver-agent 指纹与 canonical revision map 一致")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="mode", required=True)

    binaries = subparsers.add_parser("binaries", help="校验待发布的 agent 可执行文件/zip")
    binaries.add_argument("--release-assets-dir", required=True)
    binaries.add_argument("--revision-map", action="append", default=[],
                          metavar="GOOS/GOARCH=PATH")
    binaries.add_argument("--dynamic-probe", action="append", default=[],
                          metavar="GOOS/GOARCH",
                          help="该平台的 agent 经 UPX 等加壳，静态扫描不可行，改为运行时探测")
    binaries.add_argument("--skip-platform", action="append", default=[],
                          metavar="GOOS/GOARCH",
                          help="完全跳过该平台的校验（如无法在 runner 上执行的架构）")

    published = subparsers.add_parser("published", help="校验已发布的 driver manifest")
    published.add_argument("--manifest", required=True)
    published.add_argument("--revision-map", action="append", default=[],
                           metavar="GOOS/GOARCH=PATH")

    args = parser.parse_args()
    revision_maps = parse_revision_maps(args.revision_map)

    if args.mode == "binaries":
        if not Path(args.release_assets_dir).is_dir():
            raise SystemExit(f"发布产物目录不存在: {args.release_assets_dir}")
        checked, failures, skipped = verify_binaries(
            args.release_assets_dir,
            revision_maps,
            dynamic_probe_platforms=args.dynamic_probe,
            skip_platforms=args.skip_platform,
        )
    else:
        checked, failures = verify_published(args.manifest, revision_maps)
        skipped = []

    raise SystemExit(report(args.mode, checked, failures, skipped))


if __name__ == "__main__":
    main()
