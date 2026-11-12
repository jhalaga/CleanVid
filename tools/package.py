"""Build one reproducible, dependency-free extension ZIP for Chrome and Edge."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
output = ROOT / "dist" / f"cleanvid-{version}.zip"
output.parent.mkdir(exist_ok=True)
files = [ROOT / "manifest.json"]
for folder in ("src", "icons", "vendor"):
    files.extend(p for p in (ROOT / folder).rglob("*") if p.is_file())

with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for source in sorted(files):
        relative = source.relative_to(ROOT).as_posix()
        info = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, source.read_bytes())

with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None, "Archive failed integrity validation"
    names = set(archive.namelist())
    assert "manifest.json" in names
    assert not any(name.startswith(("tests/", "tools/", "docs/", ".git/", "dist/")) for name in names)

digest = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix(".zip.sha256").write_text(f"{digest}  {output.name}\n", encoding="utf-8")
print(f"Created {output}: {len(files)} files, {output.stat().st_size:,} bytes")
print(f"SHA-256: {digest}")
