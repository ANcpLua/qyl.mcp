#!/usr/bin/env python3
"""Build the local OpenAI draft package from submission/qyl, without uploading it."""

import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

submission = Path(__file__).resolve().parent
root = submission / "qyl"
version = json.loads((root / "plugin.json").read_text())["version"]
destination = submission / "packages" / f"qyl-openai-{version}-draft.zip"
destination.parent.mkdir(parents=True, exist_ok=True)

with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for source in sorted(root.rglob("*")):
        if not source.is_file():
            continue
        relative = source.relative_to(root).as_posix()
        if relative.startswith(".claude-plugin/") or relative == ".mcp.json":
            continue
        info = ZipInfo(relative, date_time=(2026, 10, 8, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, source.read_bytes())

with ZipFile(destination) as archive:
    print("\n".join(archive.namelist()))
print("sha256", hashlib.sha256(destination.read_bytes()).hexdigest())
