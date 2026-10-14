#!/usr/bin/env python3
"""Check tracked source for internal writing and accidentally committed local state."""

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
HAN = re.compile("[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U000323af]")
PRIVATE_PATH = re.compile(r"/(?:Users|home)/[A-Za-z0-9_.-]+/")
FORBIDDEN_PATH = re.compile(
    r"(^|/)(plans?|proposals?|scratch|tmp|sean_demo|node_modules|\.artifacts|\.worktrees)(/|$)"
    r"|(^|/)[^/]*(?:-proposal|-plan)\.md$|\.excalidraw$"
    r"|\.(?:sqlite3|p12|p8|pem|key)$|(^|/)\.npmrc$"
)
FORBIDDEN_HEADING = re.compile(
    r"(?im)^#{1,6} .*\b(?:implementation (?:plan|order|workstreams)|roadmap|pending triage|proposal)\b"
)


def files(repository):
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=repository)
    return [Path(name) for name in output.decode().split("\0") if name]


errors = []
count = 0
for relative in files(ROOT):
    name = relative.as_posix()
    path = ROOT / relative
    if FORBIDDEN_PATH.search(name):
        errors.append(f"{name}: internal or machine-local path")
    if HAN.search(name):
        errors.append(f"{name}: non-English filename needs review")
    if path.is_symlink():
        if not path.resolve().is_relative_to(ROOT) or not path.exists():
            errors.append(f"{name}: broken or external symlink")
        continue
    if not path.is_file():
        continue
    count += 1
    raw = path.read_bytes()
    if b"\0" in raw:
        continue
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        continue
    if relative.name.startswith(".env"):
        errors.append(f"{name}: unexpected environment file")
    if PRIVATE_PATH.search(text):
        errors.append(f"{name}: machine-specific absolute path")
    if name.endswith(".md") and FORBIDDEN_HEADING.search(text):
        errors.append(f"{name}: internal planning section")
    text = re.sub(r"\\u([0-9a-fA-F]{4})", lambda match: chr(int(match[1], 16)), text)
    if name != "scripts/check-public-content.py" and HAN.search(text):
        errors.append(f"{name}: Chinese internal text needs review")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"Public-content check passed for {count} tracked files.")
