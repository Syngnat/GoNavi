#!/usr/bin/env python3
"""向 shared/i18n/*.json 追加文案键（只做文本追加，不改动已有行）。

输入是一个 JSON 文件：{"key": {"zh-CN": "...", "zh-TW": "...", "en-US": "...", ...}}。
六种语言必须齐全（catalog_test 要求各语言键集合一致）。已存在的键会被拒绝，避免静默覆盖译文。
新键追加在文件末尾、保持原有换行风格；运行后执行 `go generate ./shared/i18n` 重新生成 catalog.zip。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

LANGUAGES = ("zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "ru-RU")
I18N_DIR = Path(__file__).resolve().parent.parent / "shared" / "i18n"
LF = chr(10)
CRLF = chr(13) + chr(10)


def append_entries(path: Path, entries: dict[str, str]) -> None:
    raw = path.read_bytes().decode("utf-8")
    existing = json.loads(raw)
    clashes = [key for key in entries if key in existing]
    if clashes:
        raise SystemExit(f"{path.name}: keys already exist: {', '.join(clashes)}")
    newline = CRLF if CRLF in raw else LF
    body = raw.rstrip()
    if not body.endswith("}"):
        raise SystemExit(f"{path.name}: unexpected trailing content")
    body = body[:-1].rstrip()
    lines = [f"  {json.dumps(key, ensure_ascii=False)}: {json.dumps(value, ensure_ascii=False)}" for key, value in entries.items()]
    separator = "," if not body.endswith("{") else ""
    text = body + separator + newline + ("," + newline).join(lines) + newline + "}" + newline
    json.loads(text)
    path.write_bytes(text.encode("utf-8"))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: i18n-add-keys.py <entries.json>", file=sys.stderr)
        return 2
    entries = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    for key, translations in entries.items():
        missing = [lang for lang in LANGUAGES if not str(translations.get(lang, "")).strip()]
        if missing:
            print(f"{key}: missing {', '.join(missing)}", file=sys.stderr)
            return 1
    for lang in LANGUAGES:
        append_entries(I18N_DIR / f"{lang}.json", {key: values[lang] for key, values in entries.items()})
    print(f"appended {len(entries)} keys to {len(LANGUAGES)} languages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
