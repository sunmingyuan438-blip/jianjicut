"""Fallback download for hosts where Node's downloader cannot use system proxy settings."""
import hashlib
import json
import urllib.request
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
package = root / "node_modules/electron"
version = json.loads((package / "package.json").read_text())["version"]
name = f"electron-v{version}-win32-x64.zip"
cache = root / ".test-data/downloads"
cache.mkdir(parents=True, exist_ok=True)
archive = cache / name
if not archive.exists():
    urllib.request.urlretrieve(f"https://github.com/electron/electron/releases/download/v{version}/{name}", archive)
expected = json.loads((package / "checksums.json").read_text())[name]
actual = hashlib.sha256(archive.read_bytes()).hexdigest()
if actual != expected:
    raise RuntimeError("Electron archive checksum mismatch")
with zipfile.ZipFile(archive) as source:
    source.extractall(package / "dist")
(package / "path.txt").write_text("electron.exe")
print(json.dumps({"electron": version, "sha256_verified": True, "archive": str(archive)}))
