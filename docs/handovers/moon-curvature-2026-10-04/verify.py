"""Verify a cloud checkout's preserved evidence hashes and Markdown links."""

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

bundle = Path(__file__).resolve().parent
manifest = json.loads((bundle / "manifest.json").read_text())
errors = []
listed = {entry["path"] for entry in manifest["files"]}
present = {
    path.relative_to(bundle).as_posix()
    for path in bundle.rglob("*")
    if path.is_file() and path.name != "manifest.json"
}
if listed != present:
    errors.append(f"File list differs: missing={listed - present}, extra={present - listed}")

for entry in manifest["files"]:
    path = bundle / entry["path"]
    if not path.is_file():
        continue
    data = path.read_bytes()
    if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
        errors.append(f"Hash or size mismatch: {entry['path']}")

for document in bundle.glob("*.md"):
    for link in re.findall(r"\]\(([^)]+)\)", document.read_text()):
        url = urlsplit(link)
        if url.scheme or not url.path:
            continue
        target = unquote(url.path)
        if target.startswith("/"):
            errors.append(f"Host-dependent link in {document.name}: {link}")
        elif not (document.parent / target).exists():
            errors.append(f"Missing link in {document.name}: {link}")

if errors:
    raise SystemExit("\n".join(errors))
print(f"Verified {len(listed)} files, their hashes and all local Markdown links.")
